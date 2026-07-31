import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  PREFIXES,
  chatStub,
  getFullGraph,
  runSparql,
} from "./ontology.js";

/* ------------------------------------------------------------------ */
/* Moteur GraphRAG du chatbot                                          */
/*   1. verbalisation des classes/propriétés en « fiches »             */
/*   2. retrieval hybride : embeddings (OpenRouter) + lexical          */
/*   3. routeur LLM : question de compréhension vs structurelle        */
/*   4. structurelle → génération SPARQL + boucle de correction        */
/*   5. réponse groundée sur le contexte, avec citations               */
/* ------------------------------------------------------------------ */

/* ---------------------- Configuration (.env) ---------------------- */

const ANALYSIS_ROOT = resolve(join(import.meta.dirname, "..", ".."));

function loadDotEnv(): void {
  const path = join(ANALYSIS_ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || m[2] === "" || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const CFG = {
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  baseUrl: (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, ""),
  modelRouter: process.env.CHAT_MODEL_ROUTER ?? "google/gemini-2.5-flash-lite",
  modelSparql: process.env.CHAT_MODEL_SPARQL ?? "anthropic/claude-sonnet-5",
  modelAnswer: process.env.CHAT_MODEL_ANSWER ?? "anthropic/claude-sonnet-5",
  modelEmbed: process.env.CHAT_EMBEDDING_MODEL ?? "openai/text-embedding-3-small",
};

const configured = () =>
  CFG.apiKey.length > 10 && !CFG.apiKey.includes("PASTE_YOUR_KEY");

/* --------------------------- Types API ----------------------------- */

export interface ChatCitation {
  iri: string;
  label: string;
  module: string;
}

/** Émetteur d'événements de pipeline (streaming NDJSON côté serveur). */
export type ChatEmit = (ev: Record<string, unknown>) => void;

export interface ChatReply {
  reply: string;
  citations?: ChatCitation[];
  sparql?: string;
  /** true si la voie SPARQL a été tentée mais a échoué (réponse via fiches) */
  sparqlFailed?: boolean;
  graph?: { tool: string; detail: string };
  route?: string;
}

interface InMessage {
  role: string;
  content: string;
}

/* ------------------------ Appels OpenRouter ------------------------ */

async function openRouter(path: string, body: unknown): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000);
  try {
    const res = await fetch(`${CFG.baseUrl}${path}`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        Authorization: `Bearer ${CFG.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-Title": "Digital Reference Explorer",
      },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.message ?? `${res.status} ${res.statusText}`;
      throw new Error(`OpenRouter ${path}: ${msg}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function llm(
  model: string,
  system: string,
  user: string,
  maxTokens = 1500
): Promise<string> {
  const json = await openRouter("/chat/completions", {
    model,
    temperature: 0,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error(`Empty response from ${model}`);
  return text;
}

async function embed(inputs: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += 96) {
    const json = await openRouter("/embeddings", {
      model: CFG.modelEmbed,
      input: inputs.slice(i, i + 96),
    });
    const data = (json?.data ?? []).sort((a: any, b: any) => a.index - b.index);
    for (const d of data) out.push(d.embedding as number[]);
  }
  if (out.length !== inputs.length)
    throw new Error(`Embeddings: got ${out.length} vectors for ${inputs.length} inputs`);
  return out;
}

/* ------------------- Fiches (verbalisation TBox) ------------------- */

function shrink(iri: string): string {
  for (const [p, ns] of Object.entries(PREFIXES)) {
    if (iri.startsWith(ns)) return `${p}:${iri.slice(ns.length)}`;
  }
  return `<${iri}>`;
}

export interface Card {
  iri: string;
  label: string;
  module: string;
  kind: "class" | "property";
  text: string; // fiche complète (contexte LLM + embedding)
  tokens: Set<string>; // index lexical
}

let cards: Card[] = [];
let cardByIri = new Map<string, Card>();
let neighborNames = new Map<string, string[]>(); // IRI classe -> voisins (labels)

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-zà-ÿ0-9]+/)
    .filter((w) => w.length >= 3);
}

function buildCards(): void {
  const { nodes, links } = getFullGraph();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const supers = new Map<string, string[]>();
  const subs = new Map<string, string[]>();
  const outProps = new Map<string, string[]>();
  const inProps = new Map<string, string[]>();
  const propPairs = new Map<string, { label: string; pairs: string[] }>();
  const neigh = new Map<string, Set<string>>();

  const push = (m: Map<string, string[]>, k: string, v: string) => {
    if (!m.has(k)) m.set(k, []);
    if (m.get(k)!.length < 8) m.get(k)!.push(v);
  };
  const addNeigh = (a: string, b: string) => {
    if (!neigh.has(a)) neigh.set(a, new Set());
    const label = nodeById.get(b)?.label;
    if (label && neigh.get(a)!.size < 12) neigh.get(a)!.add(label);
  };

  for (const l of links) {
    const s = nodeById.get(l.source);
    const t = nodeById.get(l.target);
    if (!s || !t) continue;
    addNeigh(l.source, l.target);
    addNeigh(l.target, l.source);
    if (l.type === "subclass") {
      push(supers, l.source, t.label);
      push(subs, l.target, s.label);
    } else if (l.type === "property" && l.iri) {
      push(outProps, l.source, `${l.label} → ${t.label}`);
      push(inProps, l.target, `${s.label} —${l.label}→ this`);
      if (!propPairs.has(l.iri))
        propPairs.set(l.iri, { label: l.label ?? "", pairs: [] });
      const pp = propPairs.get(l.iri)!;
      if (pp.pairs.length < 8) pp.pairs.push(`${s.label} → ${t.label}`);
    }
  }

  const list: Card[] = [];
  for (const n of nodes) {
    const parts: string[] = [];
    parts.push(`Class: ${n.label} (${shrink(n.id)})`);
    parts.push(
      `Module: ${n.module}${n.lobes.length ? ` | Lobes: ${n.lobes.join(", ")}` : ""}`
    );
    if (n.comment) parts.push(`Definition: ${n.comment}`);
    if (supers.has(n.id)) parts.push(`Superclasses: ${supers.get(n.id)!.join(", ")}`);
    if (subs.has(n.id)) parts.push(`Subclasses: ${subs.get(n.id)!.join(", ")}`);
    if (outProps.has(n.id)) parts.push(`Properties: ${outProps.get(n.id)!.join("; ")}`);
    if (inProps.has(n.id)) parts.push(`Incoming: ${inProps.get(n.id)!.join("; ")}`);
    if (n.attributes.length)
      parts.push(
        `Attributes: ${n.attributes
          .slice(0, 8)
          .map((a) => `${a.label}${a.range ? ` (${a.range})` : ""}`)
          .join(", ")}`
      );
    const text = parts.join("\n");
    list.push({
      iri: n.id,
      label: n.label,
      module: n.module,
      kind: "class",
      text,
      tokens: new Set(tokenize(`${n.label} ${n.id} ${n.comment ?? ""}`)),
    });
  }
  for (const [iri, { label, pairs }] of propPairs) {
    const text = `Object property: ${label} (${shrink(iri)})\nConnects: ${pairs.join("; ")}`;
    list.push({
      iri,
      label,
      module: moduleName(iri),
      kind: "property",
      text,
      tokens: new Set(tokenize(`${label} ${iri}`)),
    });
  }

  cards = list;
  cardByIri = new Map(list.map((c) => [c.iri, c]));
  neighborNames = new Map(
    [...neigh.entries()].map(([iri, set]) => [iri, [...set]])
  );
}

function moduleName(iri: string): string {
  const m = iri.match(/ecsel-dr(?:-([A-Za-z0-9-]+))?#/);
  return m ? m[1] ?? "Core" : "External";
}

/* ---------------- Index embeddings (cache disque) ------------------ */

const CACHE_DIR = join(ANALYSIS_ROOT, ".cache");
let vectors: Float32Array[] | null = null;
let indexPromise: Promise<void> | null = null;

function cacheHash(): string {
  // Basé sur les IRIs (triés) et non le texte des fiches : l'ordre des
  // résultats SPARQL n'est pas déterministe, le texte varie d'un démarrage
  // à l'autre alors que le contenu sémantique est identique.
  let h = 5381;
  const all = CFG.modelEmbed + "|" + cards.map((c) => c.iri).sort().join("|");
  for (let i = 0; i < all.length; i++) h = ((h * 33) ^ all.charCodeAt(i)) >>> 0;
  return `${h.toString(16)}-${cards.length}`;
}

async function ensureIndex(): Promise<void> {
  if (vectors) return;
  if (!indexPromise) {
    indexPromise = (async () => {
      if (cards.length === 0) buildCards();
      const texts = cards.map((c) => c.text);
      const hash = cacheHash();
      const cachePath = join(CACHE_DIR, `chat-embeddings-${hash}.json`);
      if (existsSync(cachePath)) {
        const raw = JSON.parse(readFileSync(cachePath, "utf8")) as number[][];
        vectors = raw.map((v) => Float32Array.from(v));
        console.log(`[chat] ${vectors.length} embeddings chargés depuis le cache`);
        return;
      }
      console.log(`[chat] calcul des embeddings (${texts.length} fiches, ${CFG.modelEmbed})…`);
      const t0 = Date.now();
      const embs = await embed(texts);
      vectors = embs.map((v) => Float32Array.from(v));
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(
        cachePath,
        JSON.stringify(embs.map((v) => v.map((x) => Math.round(x * 1e5) / 1e5)))
      );
      console.log(`[chat] embeddings prêts en ${Math.round((Date.now() - t0) / 1000)} s (cache: ${cachePath})`);
    })().catch((e) => {
      indexPromise = null; // permettre une nouvelle tentative
      throw e;
    });
  }
  return indexPromise;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/* ---------------------- Retrieval hybride -------------------------- */

interface ScoredCandidate {
  card: Card;
  score: number;
  sem: number;
  lex: number;
}

function retrieve(
  question: string,
  qv: Float32Array | null,
  extra: ExtraIndex | null,
  k = 12
): { top: Card[]; scored: ScoredCandidate[]; poolSize: number } {
  if (cards.length === 0) buildCards();
  const pool = extra ? [...cards, ...extra.cards] : cards;
  const vecAt = (i: number): Float32Array | null =>
    i < cards.length
      ? (vectors?.[i] ?? null)
      : (extra!.vectors[i - cards.length] ?? null);
  const qTokens = tokenize(question);

  // Score lexical : recouvrement de tokens + bonus label exact
  const lex = pool.map((c) => {
    let score = 0;
    for (const t of qTokens) if (c.tokens.has(t)) score++;
    const ql = question.toLowerCase();
    if (score > 0 && ql.includes(c.label.toLowerCase())) score += 3;
    return score;
  });
  const lexMax = Math.max(...lex, 1);

  const scored: ScoredCandidate[] = pool.map((c, i) => {
    const v = qv ? vecAt(i) : null;
    const semScore = qv && v ? cosine(qv, v) : 0;
    const lexScore = lex[i] / lexMax;
    return {
      card: c,
      sem: semScore,
      lex: lexScore,
      score: qv && v ? 0.65 * semScore + 0.35 * lexScore : lexScore,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return {
    top: scored.slice(0, k).map((s) => s.card),
    scored: scored.slice(0, 20),
    poolSize: pool.length,
  };
}

/* --------------------------- Prompts ------------------------------- */

const PREFIX_HEADER = Object.entries(PREFIXES)
  .map(([p, ns]) => `PREFIX ${p}: <${ns}>`)
  .join("\n");

function contextBlock(retrieved: Card[]): string {
  const blocks = retrieved.map((c) => c.text);
  // Voisinage 1 saut des meilleures classes : donne au LLM la structure locale
  for (const c of retrieved.slice(0, 4)) {
    const nb = neighborNames.get(c.iri);
    if (nb?.length) blocks.push(`Neighbors of ${c.label}: ${nb.join(", ")}`);
  }
  return blocks.join("\n---\n");
}

async function routeQuestion(question: string, history: string): Promise<string> {
  const sys =
    "You classify user questions about an OWL ontology (the Digital Reference, " +
    "semiconductor supply chains). Reply with STRICT JSON only: " +
    '{"route":"lookup"} or {"route":"structural"} or {"route":"graph"}. ' +
    'Use "structural" when answering requires a SPARQL query: counting, ' +
    "exhaustive lists (\"all subclasses of…\"), which classes use a property, " +
    "cross-module inventories. " +
    'Use "graph" for graph-algorithm and ranking questions: longest or deepest ' +
    "subclass chains, shortest path between two concepts, how two concepts " +
    "are connected, most connected classes / hubs, which classes have the " +
    "most subclasses. " +
    'Use "lookup" for definitions, explanations, comparisons and overview ' +
    "questions answerable from concept descriptions.";
  try {
    const out = await llm(CFG.modelRouter, sys, `${history}Question: ${question}`, 30);
    const m = out.match(/"route"\s*:\s*"(lookup|structural|graph)"/);
    return m ? m[1] : "lookup";
  } catch {
    return "lookup"; // le routeur ne doit jamais bloquer la réponse
  }
}

async function generateSparql(
  question: string,
  retrieved: Card[],
  emit: ChatEmit
): Promise<{ sparql: string; results: string } | null> {
  const sys =
    "You translate a question about the Digital Reference OWL ontology into ONE " +
    "SPARQL 1.1 query for an oxigraph store that contains ONLY the ontology TBox " +
    "(classes, rdfs:subClassOf, owl:ObjectProperty with rdfs:domain/rdfs:range — " +
    "possibly through owl:unionOf lists —, owl:DatatypeProperty, rdfs:label, " +
    "rdfs:comment). There are NO instances/individuals.\n" +
    "Rules:\n" +
    "- Output ONLY the SPARQL query. No markdown fences, no comments, no prose.\n" +
    "- The prefixes below are ALREADY declared server-side: do NOT redeclare them.\n" +
    "- SELECT or ASK only. Add LIMIT 200 to SELECT queries without aggregates.\n" +
    "- Prefer OPTIONAL { ?x rdfs:label ?label } so results carry labels.\n" +
    "- For transitive hierarchy use rdfs:subClassOf+ or rdfs:subClassOf*.\n" +
    "- For domains/ranges also check the owl:unionOf pattern: " +
    "?p rdfs:domain/owl:unionOf/rdf:rest*/rdf:first ?c.\n" +
    "- The DR groups classes into 'lobes': top-level classes named *_Lobe " +
    "(e.g. dr:Supply_Chain_Lobe). Membership of a class in a lobe is " +
    "expressed as ?c rdfs:subClassOf* dr:X_Lobe. To intersect two lobes, " +
    "combine two such patterns on the same ?c.\n\n" +
    `Declared prefixes:\n${PREFIX_HEADER}`;
  const ctx = retrieved
    .slice(0, 8)
    .map((c) => `${shrink(c.iri)} — ${c.label} (${c.kind})`)
    .join("\n");

  let feedback = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    let sparql: string;
    try {
      sparql = await llm(
        CFG.modelSparql,
        sys,
        `Question: ${question}\n\nRelevant ontology entities:\n${ctx}${feedback}`,
        900
      );
    } catch (e) {
      console.warn(`[chat] génération SPARQL impossible: ${(e as Error).message}`);
      return null;
    }
    sparql = sparql.replace(/^```(?:sparql)?\s*/i, "").replace(/```\s*$/, "").trim();
    emit({ type: "sparql_attempt", attempt: attempt + 1, query: sparql });
    try {
      const res = runSparql(PREFIX_HEADER + "\n" + sparql) as any;
      const rows = res?.results?.bindings ?? [];
      const isBool = res?.type === "boolean";
      emit({
        type: "sparql_result",
        attempt: attempt + 1,
        ok: true,
        rows: isBool ? 1 : rows.length,
      });
      if (!isBool && rows.length === 0 && attempt < 2) {
        // Si « 0 résultat » se confirme au dernier essai, c'est LA réponse
        // (ex. une intersection réellement vide) : on la garde.
        feedback = `\n\nPrevious query returned 0 results — likely wrong IRIs or structure. Try different entities or a broader pattern. If you are confident the query is correct, return it unchanged.\nPrevious query:\n${sparql}`;
        continue;
      }
      if (!isBool && rows.length === 0) {
        return { sparql, results: "(0 rows — nothing matches this pattern in the ontology)" };
      }
      const compact = isBool
        ? `ASK → ${res.boolean}`
        : rows
            .slice(0, 60)
            .map((r: Record<string, { value: string }>) =>
              Object.entries(r)
                .map(([k, v]) => `${k}=${v.value}`)
                .join(" | ")
            )
            .join("\n");
      const suffix = rows.length > 60 ? `\n… (${rows.length} rows total)` : "";
      return { sparql, results: compact + suffix };
    } catch (e) {
      emit({
        type: "sparql_result",
        attempt: attempt + 1,
        ok: false,
        error: (e as Error).message.slice(0, 300),
      });
      feedback = `\n\nPrevious query failed with error: ${(e as Error).message}\nPrevious query:\n${sparql}\nFix it.`;
    }
  }
  return null;
}

/* --------- Outils graphe : ce que SPARQL ne sait pas exprimer ------- */
/* (plus longue chaîne, plus court chemin, hubs) — calculés en JS sur le
   graphe en mémoire, exposés au LLM comme une 3e route.                  */

function subclassChildren(): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const l of getFullGraph().links) {
    if (l.type !== "subclass") continue;
    if (!children.has(l.target)) children.set(l.target, []);
    children.get(l.target)!.push(l.source);
  }
  return children;
}

function nodeLabel(iri: string): string {
  const c = cardByIri.get(iri);
  return c ? `${c.label} (${shrink(iri)})` : shrink(iri);
}

function toolLongestChain(rootIri?: string): string {
  const children = subclassChildren();
  let best: string[] = [];
  const dfs = (node: string, path: string[]) => {
    if (path.length > best.length) best = [...path];
    for (const c of children.get(node) ?? []) {
      if (!path.includes(c)) dfs(c, [...path, c]);
    }
  };
  if (rootIri) {
    dfs(rootIri, [rootIri]);
  } else {
    const hasParent = new Set(
      getFullGraph().links.filter((l) => l.type === "subclass").map((l) => l.source)
    );
    for (const n of getFullGraph().nodes) if (!hasParent.has(n.id)) dfs(n.id, [n.id]);
  }
  if (best.length <= 1) return "No subclass chain found under this root.";
  return (
    `Longest subClassOf chain: ${best.length} levels (computed exhaustively on the full hierarchy)\n` +
    best.map(nodeLabel).join("\n  → subclass: ")
  );
}

function toolShortestPath(from: string, to: string): string {
  const adj = new Map<string, { next: string; via: string }[]>();
  for (const l of getFullGraph().links) {
    const via = l.type === "subclass" ? "subClassOf" : l.label ?? "property";
    if (!adj.has(l.source)) adj.set(l.source, []);
    if (!adj.has(l.target)) adj.set(l.target, []);
    adj.get(l.source)!.push({ next: l.target, via });
    adj.get(l.target)!.push({ next: l.source, via: `inverse of ${via}` });
  }
  const prev = new Map<string, { from: string; via: string }>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === to) break;
    for (const { next, via } of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, { from: cur, via });
      queue.push(next);
    }
  }
  if (!seen.has(to)) return `No path found between ${nodeLabel(from)} and ${nodeLabel(to)} in the ontology graph.`;
  const steps: string[] = [];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur)!;
    steps.unshift(`—[${p.via}]→ ${nodeLabel(cur)}`);
    cur = p.from;
  }
  return `Shortest path (${steps.length} hops):\n${nodeLabel(from)}\n${steps.join("\n")}`;
}

function toolTopSubclasses(n = 10): string {
  const counts = new Map<string, number>();
  for (const l of getFullGraph().links) {
    if (l.type !== "subclass") continue;
    counts.set(l.target, (counts.get(l.target) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return (
    `Classes with the most DIRECT subclasses (exhaustive count over the whole ontology):\n` +
    sorted.map(([iri, c], i) => `${i + 1}. ${nodeLabel(iri)} — ${c} direct subclasses`).join("\n")
  );
}

function toolTopDegree(n = 10): string {
  const sorted = [...getFullGraph().nodes].sort((a, b) => b.degree - a.degree).slice(0, n);
  return (
    `Most connected classes (degree = subclass + property edges):\n` +
    sorted.map((x, i) => `${i + 1}. ${nodeLabel(x.id)} — degree ${x.degree}`).join("\n")
  );
}

async function runGraphTool(
  question: string,
  retrieved: Card[],
  emit: ChatEmit
): Promise<{ tool: string; detail: string } | null> {
  const sys =
    "You pick ONE graph computation to answer a question about an ontology " +
    "class graph. Reply with STRICT JSON only, one of:\n" +
    '{"tool":"longest_chain","root":"<class IRI, or empty for the whole ontology>"}\n' +
    '{"tool":"shortest_path","from":"<class IRI>","to":"<class IRI>"}\n' +
    '{"tool":"top_degree","n":10}  (most connected: subclass + property edges)\n' +
    '{"tool":"top_subclasses","n":10}  (classes with the most direct subclasses)\n' +
    "Use full IRIs picked from the candidate entities provided.";
  const ctx = retrieved
    .filter((c) => c.kind === "class")
    .slice(0, 10)
    .map((c) => `${c.iri} — ${c.label}`)
    .join("\n");
  try {
    const out = await llm(
      CFG.modelSparql,
      sys,
      `Question: ${question}\n\nCandidate entities:\n${ctx}`,
      200
    );
    const jsonText = out.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const spec = JSON.parse(jsonText) as Record<string, string | number>;
    emit({ type: "graph_tool", tool: spec.tool, args: spec });
    let detail: string;
    if (spec.tool === "longest_chain") {
      detail = toolLongestChain((spec.root as string) || undefined);
    } else if (spec.tool === "shortest_path") {
      detail = toolShortestPath(String(spec.from), String(spec.to));
    } else if (spec.tool === "top_degree") {
      detail = toolTopDegree(Number(spec.n) || 10);
    } else if (spec.tool === "top_subclasses") {
      detail = toolTopSubclasses(Number(spec.n) || 10);
    } else {
      return null;
    }
    emit({ type: "graph_result", detail: detail.slice(0, 1500) });
    return { tool: String(spec.tool), detail };
  } catch (e) {
    console.warn(`[chat] outil graphe indisponible: ${(e as Error).message}`);
    return null;
  }
}

/* ---- Accès pour le module workspace (comparaison / mapping) ---------- */

export async function drIndex(): Promise<{
  cards: Card[];
  vectors: Float32Array[];
}> {
  await ensureIndex();
  return { cards, vectors: vectors! };
}

export { embed as embedTexts, llm as llmCall, cosine, CFG as chatConfig };

/** Index additionnel (ontologies importées sélectionnées dans le chat). */
export interface ExtraIndex {
  cards: Card[];
  vectors: Float32Array[];
}

/* ---- Question autonome : les relances (« et pour X ? ») sont réécrites
   avec le contexte de la conversation, pour que retrieval, routeur, SPARQL
   et outils graphe voient la vraie question. ------------------------------ */

async function condenseQuestion(question: string, history: string): Promise<string> {
  const sys =
    "Rewrite the user's LAST message as ONE fully self-contained question " +
    "about the Digital Reference ontology, resolving pronouns and references " +
    "(\"it\", \"the second one\", \"et pour X ?\") using the conversation. " +
    "Keep the SAME language as the last message. If it is already " +
    "self-contained, return it UNCHANGED. Return ONLY the question, nothing else.";
  try {
    const out = await llm(
      CFG.modelRouter,
      sys,
      `Conversation:\n${history}\n\nLast message: ${question}`,
      150
    );
    const t = out.trim().replace(/^["«\s]+|["»\s]+$/g, "");
    return t.length > 3 && t.length < 600 ? t : question;
  } catch {
    return question; // la condensation ne doit jamais bloquer la réponse
  }
}

/* ------------------------- Point d'entrée -------------------------- */

export async function answerChat(
  messages: InMessage[],
  emit: ChatEmit = () => {},
  extra: ExtraIndex | null = null
): Promise<ChatReply> {
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const question = typeof lastUser?.content === "string" ? lastUser.content.trim() : "";
  if (!question) return { reply: "Please ask a question about the Digital Reference." };

  if (!configured()) {
    return {
      reply:
        "**Chatbot not configured yet** — set `OPENROUTER_API_KEY` in `analysis/.env` " +
        "(see `analysis/.env.example`), then restart the backend.\n\n" +
        "Meanwhile, here is a simple lexical search:\n\n" +
        chatStub(question),
    };
  }

  // Historique : jusqu'à 4 échanges précédents (réponses tronquées à 700 c.)
  const history = messages
    .slice(-9, -1)
    .filter((m) => typeof m?.content === "string")
    .map(
      (m) => `${m.role}: ${m.content.slice(0, m.role === "assistant" ? 700 : 400)}`
    )
    .join("\n");
  const historyBlock = history ? `Conversation so far:\n${history}\n\n` : "";

  // 0. Relance conversationnelle → question autonome (query condensation)
  emit({ type: "stage", stage: "embed", status: "start" });
  let standalone = question;
  if (history) {
    standalone = await condenseQuestion(question, history);
    if (standalone !== question) emit({ type: "rewrite", standalone });
  }

  // 1. Vectorisation de la question (l'index des fiches est construit ou
  //    rechargé du cache au premier appel)
  let qv: Float32Array | null = null;
  {
    const t0 = Date.now();
    try {
      await ensureIndex();
      const [raw] = await embed([standalone]);
      qv = Float32Array.from(raw);
      emit({
        type: "embed",
        dims: qv.length,
        preview: Array.from(qv.slice(0, 48)).map((x) => Math.round(x * 1e4) / 1e4),
        tookMs: Date.now() - t0,
      });
    } catch (e) {
      console.warn(`[chat] embeddings indisponibles, retrieval lexical seul (${(e as Error).message})`);
      emit({ type: "embed", dims: 0, preview: [], tookMs: Date.now() - t0, error: "embeddings unavailable — lexical fallback" });
    }
  }

  // 2. Vector search hybride sur les fiches
  emit({ type: "stage", stage: "retrieve", status: "start" });
  const t1 = Date.now();
  const { top: retrieved, scored, poolSize } = retrieve(standalone, qv, extra);
  emit({
    type: "retrieval",
    total: poolSize,
    tookMs: Date.now() - t1,
    candidates: scored.map((s) => ({
      iri: s.card.iri,
      label: s.card.label,
      module: s.card.module,
      kind: s.card.kind,
      score: Math.round(s.score * 1e4) / 1e4,
      sem: Math.round(s.sem * 1e4) / 1e4,
      lex: Math.round(s.lex * 1e4) / 1e4,
    })),
  });

  // 3. Routage lookup / structural
  emit({ type: "stage", stage: "route", status: "start" });
  const route = await routeQuestion(standalone, historyBlock);
  emit({ type: "route", route });

  let sparqlBlock = "";
  let usedSparql: string | undefined;
  let sparqlFailed = false;
  let graphUsed: { tool: string; detail: string } | undefined;
  if (route === "structural") {
    emit({ type: "stage", stage: "sparql", status: "start" });
    const gen = await generateSparql(standalone, retrieved, emit);
    if (gen) {
      usedSparql = gen.sparql;
      sparqlBlock = `\n\nSPARQL query executed on the ontology:\n${gen.sparql}\n\nResults:\n${gen.results}`;
    } else {
      sparqlFailed = true;
      sparqlBlock =
        "\n\nNote: SPARQL query attempts FAILED. Answer from the concept cards " +
        "only, and explicitly tell the user that the structural query could not " +
        "be executed, so the answer may be incomplete.";
    }
  } else if (route === "graph") {
    emit({ type: "stage", stage: "graph", status: "start" });
    const g = await runGraphTool(standalone, retrieved, emit);
    if (g) {
      graphUsed = { tool: g.tool, detail: g.detail.slice(0, 2000) };
      sparqlBlock = `\n\nGraph computation executed on the ontology graph (exact, exhaustive):\n${g.detail}`;
    }
  }

  const sys =
    "You are the assistant of the Digital Reference Explorer, answering questions " +
    "about the Digital Reference — an open-source OWL ontology of semiconductor " +
    "supply chains.\n" +
    "STRICT rules:\n" +
    "- Answer ONLY from the provided context (concept cards and SPARQL results). " +
    "If the context does not contain the answer, say you could not find it in the " +
    "ontology — never invent classes, properties or facts.\n" +
    "- Cite the concepts you use as **Label** (`prefixed:IRI`).\n" +
    "- The context may also contain classes from IMPORTED ontologies (their " +
    "module is the ontology name) with their alignment links to the DR " +
    "(equivalent / subclass of / close match). Use them, and make the DR " +
    "links explicit when they help the answer.\n" +
    "- Answer in the SAME language as the question (English question => English " +
    "answer, French => French). Ignore the language of the ontology content.\n" +
    "- Be concise and structured (markdown: short paragraphs, lists).\n" +
    "- When the answer describes how several concepts relate (causal chains, " +
    "flows, hierarchies, multi-step structures), ALSO append ONE diagram block " +
    "at the end, formatted EXACTLY as:\n" +
    "```diagram\n" +
    "Source Label (prefix:Local_Name) -> Target Label (prefix:Local_Name) : property label\n" +
    "```\n" +
    "one edge per line (max 12 edges), using only concepts and relations from " +
    "the context. ALWAYS include the (prefix:Local_Name) parenthesis for BOTH " +
    "source and target. Never use ASCII art. Skip the diagram for simple " +
    "definition answers where it would add nothing.";
  const user =
    `${historyBlock}Question: ${question}\n` +
    (standalone !== question
      ? `(follow-up interpreted in context as: ${standalone})\n`
      : "") +
    `\nOntology context:\n${contextBlock(retrieved)}${sparqlBlock}`;

  emit({ type: "stage", stage: "answer", status: "start" });
  const reply = await llm(CFG.modelAnswer, sys, user, 1600);

  const seen = new Set<string>();
  const citations: ChatCitation[] = retrieved
    .filter((c) => c.kind === "class")
    .filter((c) => {
      const k = `${c.label}|${c.module}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8)
    .map((c) => ({ iri: c.iri, label: c.label, module: c.module }));

  return {
    reply,
    citations,
    sparql: usedSparql,
    sparqlFailed: sparqlFailed || undefined,
    graph: graphUsed,
    route,
  };
}
