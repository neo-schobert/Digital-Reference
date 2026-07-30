import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import oxigraph from "oxigraph";
import { db, DATA_DIR } from "./chatstore.js";
import {
  Card,
  chatConfig,
  cosine,
  drIndex,
  embedTexts,
  llmCall,
} from "./chat.js";

/* ------------------------------------------------------------------ */
/* Workspace : ontologies importées par l'utilisateur                  */
/*  - persistance : fichiers dans analysis/.data/workspace/ + SQLite   */
/*  - comparaison au Digital Reference (embeddings, sans LLM)          */
/*  - mapping : nouvelle ontologie = copie de l'importée + axiomes de  */
/*    liaison vers le DR (equivalentClass / subClassOf / closeMatch).  */
/*    Le DR n'est JAMAIS modifié.                                      */
/* ------------------------------------------------------------------ */

const WS_DIR = join(DATA_DIR, "workspace");
mkdirSync(WS_DIR, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS ws_ontologies (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    filename    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    triples     INTEGER NOT NULL,
    classes     INTEGER NOT NULL,
    properties  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ws_results (
    onto_id     TEXT NOT NULL,
    kind        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    data        TEXT NOT NULL,
    PRIMARY KEY (onto_id, kind)
  );
`);

const VALID_ID = /^[A-Za-z0-9-]{8,64}$/;

const FORMAT_BY_EXT: Record<string, string> = {
  ttl: "text/turtle",
  n3: "text/turtle",
  nt: "application/n-triples",
  rdf: "application/rdf+xml",
  owl: "application/rdf+xml",
  xml: "application/rdf+xml",
};

/* --------------------- Parsing d'une ontologie --------------------- */

interface WsClass {
  iri: string;
  label: string;
  comment?: string;
  supers: string[];
  text: string; // fiche verbalisée (embedding + prompts)
}

function localName(iri: string): string {
  const idx = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/"));
  return idx >= 0 ? iri.slice(idx + 1) : iri;
}

function loadStore(content: string, ext: string): InstanceType<typeof oxigraph.Store> {
  const store = new oxigraph.Store();
  const format = FORMAT_BY_EXT[ext] ?? "text/turtle";
  const base = "http://example.org/imported#";
  try {
    store.load(content, { format, base_iri: base });
  } catch (e) {
    try {
      (store.load as unknown as (d: string, f: string, b: string) => void)(
        content,
        format,
        base
      );
    } catch {
      throw e;
    }
  }
  return store;
}

function parseClasses(store: InstanceType<typeof oxigraph.Store>): {
  classes: WsClass[];
  propertyCount: number;
} {
  type Term = { termType: string; value: string; language?: string };
  type Binding = Map<string, Term>;
  const q = (sparql: string) =>
    store.query(
      `PREFIX owl: <http://www.w3.org/2002/07/owl#>
       PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
       PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
       PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
       ${sparql}`
    ) as Binding[];

  const byIri = new Map<string, WsClass>();
  for (const b of q(
    `SELECT ?c ?label ?comment WHERE {
       { ?c a owl:Class } UNION { ?c a rdfs:Class }
       FILTER(isIRI(?c))
       OPTIONAL { ?c rdfs:label ?label }
       OPTIONAL { { ?c rdfs:comment ?comment } UNION { ?c skos:definition ?comment } }
     }`
  )) {
    const iri = b.get("c")!.value;
    let c = byIri.get(iri);
    if (!c) {
      c = { iri, label: localName(iri), supers: [], text: "" };
      byIri.set(iri, c);
    }
    const label = b.get("label");
    if (label && (c.label === localName(iri) || label.language === "en"))
      c.label = label.value;
    const comment = b.get("comment");
    if (comment && (!c.comment || comment.language === "en"))
      c.comment = comment.value;
  }
  for (const b of q(
    `SELECT ?s ?o WHERE { ?s rdfs:subClassOf ?o . FILTER(isIRI(?s) && isIRI(?o)) }`
  )) {
    const c = byIri.get(b.get("s")!.value);
    const o = byIri.get(b.get("o")!.value);
    if (c && o && c.supers.length < 6) c.supers.push(o.label);
  }
  let propertyCount = 0;
  for (const _ of q(
    `SELECT DISTINCT ?p WHERE {
       { ?p a owl:ObjectProperty } UNION { ?p a owl:DatatypeProperty } UNION { ?p a rdf:Property }
       FILTER(isIRI(?p))
     }`
  ))
    propertyCount++;

  const classes = [...byIri.values()].map((c) => {
    const parts = [`Class: ${c.label} (<${c.iri}>)`];
    if (c.comment) parts.push(`Definition: ${c.comment}`);
    if (c.supers.length) parts.push(`Superclasses: ${c.supers.join(", ")}`);
    c.text = parts.join("\n");
    return c;
  });
  return { classes, propertyCount };
}

/* ------------------------------ CRUD ------------------------------- */

export interface WsOntology {
  id: string;
  name: string;
  createdAt: number;
  triples: number;
  classes: number;
  properties: number;
  hasCompare: boolean;
  hasMapping: boolean;
  /** Score de liaison au DR si un mapping existe (0-100) */
  linkScore?: number;
  /** Similarité moyenne au DR si une comparaison existe (0-100) */
  similarityScore?: number;
}

function resultExists(id: string, kind: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM ws_results WHERE onto_id = ? AND kind = ?`)
    .get(id, kind);
}

export function listOntologies(): WsOntology[] {
  const rows = db
    .prepare(`SELECT * FROM ws_ontologies ORDER BY created_at DESC`)
    .all() as any[];
  return rows.map((r) => {
    const mapping = getResult(r.id, "mapping") as MappingReport | null;
    const compare = getResult(r.id, "compare") as CompareReport | null;
    return {
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      triples: r.triples,
      classes: r.classes,
      properties: r.properties,
      hasCompare: compare !== null,
      hasMapping: mapping !== null,
      linkScore: mapping
        ? (mapping.linkScore ?? linkScoreOf(mapping.entries))
        : undefined,
      similarityScore: compare ? compare.similarityScore : undefined,
    };
  });
}

export function importOntology(
  id: string,
  name: string,
  content: string
): WsOntology {
  if (!VALID_ID.test(id)) throw new Error("Invalid id");
  const ext = (name.split(".").pop() ?? "ttl").toLowerCase();
  const store = loadStore(content, ext); // valide le fichier avant d'accepter
  const { classes, propertyCount } = parseClasses(store);
  if (classes.length === 0)
    throw new Error("No OWL/RDFS classes found in this file");
  const filename = `${id}.${ext}`;
  writeFileSync(join(WS_DIR, filename), content, "utf8");
  db.prepare(
    `INSERT INTO ws_ontologies (id, name, filename, created_at, triples, classes, properties)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, filename, Date.now(), store.size, classes.length, propertyCount);
  return listOntologies().find((o) => o.id === id)!;
}

export function deleteOntology(id: string): boolean {
  if (!VALID_ID.test(id)) return false;
  const row = db
    .prepare(`SELECT filename FROM ws_ontologies WHERE id = ?`)
    .get(id) as { filename: string } | undefined;
  if (!row) return false;
  for (const f of [row.filename, `${id}-mapped.ttl`]) {
    try {
      if (existsSync(join(WS_DIR, f))) unlinkSync(join(WS_DIR, f));
    } catch {
      /* fichier fantôme : la ligne DB part quand même */
    }
  }
  db.prepare(`DELETE FROM ws_results WHERE onto_id = ?`).run(id);
  db.prepare(`DELETE FROM ws_ontologies WHERE id = ?`).run(id);
  return true;
}

export function getResult(id: string, kind: string): unknown | null {
  const row = db
    .prepare(`SELECT data FROM ws_results WHERE onto_id = ? AND kind = ?`)
    .get(id, kind) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : null;
}

function saveResult(id: string, kind: string, data: unknown): void {
  db.prepare(
    `INSERT INTO ws_results (onto_id, kind, created_at, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(onto_id, kind) DO UPDATE SET created_at = excluded.created_at, data = excluded.data`
  ).run(id, kind, Date.now(), JSON.stringify(data));
}

export function mappedFilePath(id: string): string | null {
  const p = join(WS_DIR, `${id}-mapped.ttl`);
  return existsSync(p) ? p : null;
}

function loadImported(id: string): {
  classes: WsClass[];
  content: string;
  name: string;
  ext: string;
  store: InstanceType<typeof oxigraph.Store>;
} {
  const row = db
    .prepare(`SELECT name, filename FROM ws_ontologies WHERE id = ?`)
    .get(id) as { name: string; filename: string } | undefined;
  if (!row) throw new Error("Unknown ontology");
  const content = readFileSync(join(WS_DIR, row.filename), "utf8");
  const ext = (row.filename.split(".").pop() ?? "ttl").toLowerCase();
  const store = loadStore(content, ext);
  const { classes } = parseClasses(store);
  return { classes, content, name: row.name, ext, store };
}

/** Contenu Turtle de base pour le fichier mappé : les sources non-Turtle
    (RDF/XML…) sont converties, car on y concatène des triples Turtle. */
function turtleBase(content: string, ext: string, store: InstanceType<typeof oxigraph.Store>): string {
  if (ext === "ttl" || ext === "n3" || ext === "nt") return content;
  try {
    return store.dump({ format: "text/turtle" }) as string;
  } catch {
    return (store.dump as unknown as (f: string) => string)("text/turtle");
  }
}

/* --------------------- Similarité contre le DR --------------------- */

const MAX_CLASSES = 300;

interface MatchCandidate {
  iri: string;
  label: string;
  module: string;
  score: number;
}

async function bestDrMatches(
  classes: WsClass[]
): Promise<{ perClass: MatchCandidate[][]; truncated: number }> {
  const { cards, vectors } = await drIndex();
  const classIdx: number[] = [];
  cards.forEach((c, i) => {
    if (c.kind === "class") classIdx.push(i);
  });

  const truncated = Math.max(0, classes.length - MAX_CLASSES);
  const subset = classes.slice(0, MAX_CLASSES);
  const embs = await embedTexts(subset.map((c) => c.text));

  const perClass: MatchCandidate[][] = subset.map((wc, k) => {
    const v = Float32Array.from(embs[k]);
    const scored: MatchCandidate[] = classIdx.map((i) => ({
      iri: cards[i].iri,
      label: cards[i].label,
      module: cards[i].module,
      score: cosine(v, vectors[i]),
    }));
    // Bonus lexical : labels identiques (normalisés) => quasi-certitude
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const wcn = norm(wc.label);
    for (const s of scored) {
      if (wcn.length > 2 && norm(s.label) === wcn) s.score = Math.max(s.score, 0.95);
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3);
  });
  console.log(
    "[workspace] bestDrMatches:",
    perClass.slice(0, 3).map((c, i) => `${subset[i].label}=${c[0]?.score?.toFixed(3)}`).join(" ")
  );
  return { perClass, truncated };
}

/* --------------------------- Comparaison --------------------------- */

export interface CompareReport {
  createdAt: number;
  totalClasses: number;
  analyzed: number;
  truncated: number;
  /** Similarité moyenne au DR (0-100), avant vérification LLM */
  similarityScore: number;
  buckets: { strong: number; medium: number; weak: number };
  matches: {
    source: string;
    sourceIri: string;
    target: string;
    targetIri: string;
    module: string;
    score: number;
  }[];
}

export async function compareToDr(id: string): Promise<CompareReport> {
  const { classes } = loadImported(id);
  const { perClass, truncated } = await bestDrMatches(classes);
  const buckets = { strong: 0, medium: 0, weak: 0 };
  const matches: CompareReport["matches"] = [];
  perClass.forEach((cands, k) => {
    const best = cands[0];
    if (!best) return;
    if (best.score >= 0.75) buckets.strong++;
    else if (best.score >= 0.6) buckets.medium++;
    else buckets.weak++;
    matches.push({
      source: classes[k].label,
      sourceIri: classes[k].iri,
      target: best.label,
      targetIri: best.iri,
      module: best.module,
      score: Math.round(best.score * 1000) / 1000,
    });
  });
  matches.sort((a, b) => b.score - a.score);
  const avg =
    matches.length > 0
      ? matches.reduce((s, m) => s + m.score, 0) / matches.length
      : 0;
  const report: CompareReport = {
    createdAt: Date.now(),
    totalClasses: classes.length,
    analyzed: perClass.length,
    truncated,
    similarityScore: Math.round(avg * 100),
    buckets,
    matches,
  };
  saveResult(id, "compare", report);
  return report;
}

/* ----------------------------- Mapping ----------------------------- */

export interface MappingEntry {
  source: string;
  sourceIri: string;
  relation: "equivalent" | "subclass" | "related" | "none";
  target?: string;
  targetIri?: string;
  confidence?: number;
}

export interface MappingReport {
  createdAt: number;
  totalClasses: number;
  truncated: number;
  /** Score de liaison au DR (0-100) : couverture pondérée par relation et confiance */
  linkScore: number;
  counts: { equivalent: number; subclass: number; related: number; none: number };
  entries: MappingEntry[];
  file: string;
}

/** Couverture pondérée : ≡ 1.0, ⊑ 0.9, ≈ 0.6, none 0 — pondérée par la
    confiance du vérificateur LLM (0.7 par défaut si absente). */
function linkScoreOf(entries: MappingEntry[]): number {
  if (entries.length === 0) return 0;
  const W: Record<MappingEntry["relation"], number> = {
    equivalent: 1,
    subclass: 0.9,
    related: 0.6,
    none: 0,
  };
  const sum = entries.reduce(
    (acc, e) =>
      acc + W[e.relation] * (e.relation === "none" ? 0 : (e.confidence ?? 0.7)),
    0
  );
  return Math.round((sum / entries.length) * 100);
}

const REL_PROP: Record<string, string> = {
  equivalent: "http://www.w3.org/2002/07/owl#equivalentClass",
  subclass: "http://www.w3.org/2000/01/rdf-schema#subClassOf",
  related: "http://www.w3.org/2004/02/skos/core#closeMatch",
};

async function verifyBatch(
  items: { wc: WsClass; cands: MatchCandidate[] }[],
  drCardByIri: Map<string, Card>
): Promise<MappingEntry[]> {
  const sys =
    "You align classes of an external ontology onto the Digital Reference (DR), " +
    "an OWL ontology of semiconductor supply chains. For EACH item decide:\n" +
    '- "equivalent": same concept as the DR candidate\n' +
    '- "subclass": the external class is a MORE SPECIFIC kind of the DR candidate\n' +
    '- "related": clearly related but neither equivalent nor a subclass\n' +
    '- "none": no DR candidate fits — the class stays unlinked\n' +
    "Be conservative: prefer none over a wrong link. Use ONLY the provided " +
    "candidate IRIs. Reply with a STRICT JSON array, one object per item, " +
    'same order: [{"i":0,"relation":"equivalent","target":"<candidate iri>","confidence":0.9}] ' +
    '(omit target for "none"). No other text.';
  const user = items
    .map(({ wc, cands }, i) => {
      const cs = cands
        .map((c) => {
          const card = drCardByIri.get(c.iri);
          const def = card?.text.match(/Definition: (.*)/)?.[1]?.slice(0, 180);
          return `  - ${c.iri} — ${c.label}${def ? ` : ${def}` : ""}`;
        })
        .join("\n");
      return `Item ${i}:\nExternal class:\n${wc.text.slice(0, 400)}\nDR candidates:\n${cs}`;
    })
    .join("\n\n");
  // Budget large : les modèles récents consomment une partie de max_tokens en
  // raisonnement interne — trop bas, la sortie JSON arrive tronquée.
  const out = await llmCall(chatConfig.modelSparql, sys, user, 6000);
  const jsonText = out.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let parsed: { i: number; relation: string; target?: string; confidence?: number }[];
  try {
    parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) throw new Error("not an array");
  } catch (e) {
    // Sortie tronquée : récupérer les objets complets un par un plutôt que
    // de tout perdre (les items manquants retomberont sur « none »).
    parsed = [];
    for (const m of jsonText.matchAll(/\{[^{}]*\}/g)) {
      try {
        parsed.push(JSON.parse(m[0]));
      } catch {
        /* objet incomplet : ignoré */
      }
    }
    console.warn(
      `[workspace] réponse du vérificateur partiellement parsée (${(e as Error).message}) — ${parsed.length}/${items.length} objets récupérés`
    );
  }
  return items.map(({ wc, cands }, i) => {
    const v = parsed.find((p) => p?.i === i);
    const relation = (
      ["equivalent", "subclass", "related", "none"].includes(v?.relation ?? "")
        ? v!.relation
        : "none"
    ) as MappingEntry["relation"];
    const cand = cands.find((c) => c.iri === v?.target);
    if (relation === "none" || !cand)
      return { source: wc.label, sourceIri: wc.iri, relation: "none" as const };
    return {
      source: wc.label,
      sourceIri: wc.iri,
      relation,
      target: cand.label,
      targetIri: cand.iri,
      confidence: typeof v?.confidence === "number" ? v.confidence : undefined,
    };
  });
}

export async function mapToDr(id: string): Promise<MappingReport> {
  const { classes, content, name, ext, store } = loadImported(id);
  const { perClass, truncated } = await bestDrMatches(classes);
  const drCardByIri = new Map((await drIndex()).cards.map((c) => [c.iri, c]));

  // Vérification LLM uniquement pour les candidats plausibles (score >= 0.55)
  const toVerify: { wc: WsClass; cands: MatchCandidate[]; k: number }[] = [];
  const entries: MappingEntry[] = [];
  perClass.forEach((cands, k) => {
    if (cands[0] && cands[0].score >= 0.55) {
      toVerify.push({ wc: classes[k], cands, k });
    } else {
      entries.push({
        source: classes[k].label,
        sourceIri: classes[k].iri,
        relation: "none",
      });
    }
  });
  const BATCH = 8;
  for (let i = 0; i < toVerify.length; i += BATCH) {
    const batch = toVerify.slice(i, i + BATCH);
    try {
      entries.push(...(await verifyBatch(batch, drCardByIri)));
    } catch (e) {
      // Un lot en échec (API indisponible…) ne doit pas faire perdre le
      // mapping entier : ses classes restent non liées.
      console.warn(`[workspace] lot de vérification en échec: ${(e as Error).message}`);
      entries.push(
        ...batch.map(({ wc }) => ({
          source: wc.label,
          sourceIri: wc.iri,
          relation: "none" as const,
        }))
      );
    }
    console.log(
      `[workspace] mapping ${Math.min(i + BATCH, toVerify.length)}/${toVerify.length} classes vérifiées`
    );
  }

  /* --- Nouvelle ontologie : copie de l'importée + axiomes vers le DR --- */
  const linked = entries.filter((e) => e.relation !== "none");
  const lines: string[] = [];
  lines.push("");
  lines.push("#################################################################");
  lines.push(`# Alignment to the Digital Reference — generated ${new Date().toISOString()}`);
  lines.push(`# Source: ${name} · ${linked.length}/${entries.length} classes linked to the DR`);
  lines.push("# The Digital Reference itself is NOT modified: these axioms only");
  lines.push("# link the imported ontology's classes to DR classes.");
  lines.push("#################################################################");
  for (const e of linked) {
    if (e.confidence !== undefined)
      lines.push(`# confidence ${e.confidence.toFixed(2)} — ${e.source} → ${e.target}`);
    lines.push(`<${e.sourceIri}> <${REL_PROP[e.relation]}> <${e.targetIri}> .`);
  }
  const mapped =
    turtleBase(content, ext, store).trimEnd() + "\n" + lines.join("\n") + "\n";
  loadStore(mapped, "ttl"); // validation : le résultat doit se parser
  writeFileSync(join(WS_DIR, `${id}-mapped.ttl`), mapped, "utf8");

  const counts = { equivalent: 0, subclass: 0, related: 0, none: 0 };
  for (const e of entries) counts[e.relation]++;
  entries.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const report: MappingReport = {
    createdAt: Date.now(),
    totalClasses: classes.length,
    truncated,
    linkScore: linkScoreOf(entries),
    counts,
    entries,
    file: `${id}-mapped.ttl`,
  };
  saveResult(id, "mapping", report);
  return report;
}
