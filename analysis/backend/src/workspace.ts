import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HttpError,
  ProjectOntology,
  VALID_ID,
  WS_DIR,
  getOntology,
  getResult,
  onProjectInvalidated,
  ontologySource,
  requireProject,
  saveResult,
} from "./projects.js";
import {
  Card,
  ExtraIndex,
  chatConfig,
  cosine,
  embedTexts,
  llmCall,
  referenceIndex,
  tokenize,
} from "./chat.js";
import { getReference } from "./ontology.js";
import {
  OntoClass,
  dumpTurtle,
  loadStore,
  localName,
  parseClasses,
  select,
  type Store,
} from "./rdf.js";
import {
  Bm25Index,
  EntityProfile,
  FacetScores,
  compareEntities,
  labelTokens,
  makeProfile,
} from "./similarity.js";

/* ------------------------------------------------------------------ */
/* Comparaison et mapping d'une ontologie importée vers la RÉFÉRENCE   */
/* de son projet.                                                      */
/*  - comparaison : similarité multi-facettes (lexicale + structurelle */
/*    + sémantique, voir similarity.ts)                                */
/*  - mapping : nouvelle ontologie = copie de l'importée + axiomes     */
/*    SKOS vers la référence (exactMatch / broadMatch / closeMatch)    */
/*    réifiés avec leurs scores (vocabulaire SSSOM) + export SSSOM.    */
/*    La référence n'est JAMAIS modifiée.                              */
/* ------------------------------------------------------------------ */

const MAX_CLASSES = 300;
const EXTERNAL_SIM_BASE = (process.env.DR_SIMILARITY_BASE_URL ?? "").replace(/\/+$/, "");
const EXTERNAL_SIM_TIMEOUT_MS = Number(process.env.DR_SIMILARITY_TIMEOUT_MS ?? 45000);

function similarityWsId(projectId: string, ontologyId: string): string {
  return `${projectId}__${ontologyId}`;
}

async function simFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!EXTERNAL_SIM_BASE) throw new Error("External similarity backend is not configured");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), EXTERNAL_SIM_TIMEOUT_MS);
  try {
    return await fetch(`${EXTERNAL_SIM_BASE}${path}`, {
      ...init,
      signal: ctl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureExternalOntology(projectId: string, id: string): Promise<string> {
  const wsId = similarityWsId(projectId, id);
  const src = ontologySource(id);
  const res = await simFetch(`/api/workspace/ontologies`, {
    method: "POST",
    body: JSON.stringify({ id: wsId, name: src.name, content: src.content }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`external import failed: ${res.status} ${detail}`);
  }
  return wsId;
}

async function compareToReferenceExternal(
  projectId: string,
  id: string
): Promise<CompareReport> {
  const wsId = await ensureExternalOntology(projectId, id);
  const res = await simFetch(`/api/workspace/ontologies/${encodeURIComponent(wsId)}/compare`, {
    method: "POST",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`external compare failed: ${res.status} ${detail}`);
  }
  return (await res.json()) as CompareReport;
}

async function mapToReferenceExternal(projectId: string, id: string): Promise<MappingReport> {
  const wsId = await ensureExternalOntology(projectId, id);
  const mapRes = await simFetch(`/api/workspace/ontologies/${encodeURIComponent(wsId)}/map`, {
    method: "POST",
  });
  if (!mapRes.ok) {
    const detail = await mapRes.text().catch(() => "");
    throw new Error(`external map failed: ${mapRes.status} ${detail}`);
  }
  const report = (await mapRes.json()) as MappingReport;

  const ttlRes = await simFetch(`/api/workspace/ontologies/${encodeURIComponent(wsId)}/mapped.ttl`, {
    method: "GET",
    headers: {},
  });
  if (!ttlRes.ok) {
    const detail = await ttlRes.text().catch(() => "");
    throw new Error(`external mapped.ttl failed: ${ttlRes.status} ${detail}`);
  }
  const mapped = await ttlRes.text();
  loadStore(mapped, "ttl");
  writeFileSync(join(WS_DIR, `${id}-mapped.ttl`), mapped, "utf8");

  const sssomRes = await simFetch(`/api/workspace/ontologies/${encodeURIComponent(wsId)}/mappings.sssom.tsv`, {
    method: "GET",
    headers: {},
  });
  if (!sssomRes.ok) {
    const detail = await sssomRes.text().catch(() => "");
    throw new Error(`external sssom failed: ${sssomRes.status} ${detail}`);
  }
  const sssom = await sssomRes.text();
  writeFileSync(join(WS_DIR, `${id}-mappings.sssom.tsv`), sssom, "utf8");
  wsGraphCache.delete(`${id}:mapped`);

  return {
    ...report,
    file: `${id}-mapped.ttl`,
    sssomFile: `${id}-mappings.sssom.tsv`,
  };
}

/**
 * Ontologie du projet à aligner. Refusée si elle fait partie de la
 * référence : la référence elle-même, mais aussi ses dépendances, qui sont
 * chargées avec elle — les comparer à la référence reviendrait à les
 * comparer à elles-mêmes.
 */
function loadTarget(projectId: string, ontologyId: string): ProjectOntology {
  requireProject(projectId);
  const onto = getOntology(ontologyId);
  if (!onto || onto.projectId !== projectId)
    throw new HttpError(404, "Unknown ontology in this project");
  if (onto.isReference)
    throw new HttpError(
      400,
      "This ontology IS the project reference — import another one to compare or map it."
    );
  if (onto.inReference)
    throw new HttpError(
      400,
      "This ontology is a dependency of the project reference: it is already " +
        "part of it. Remove it from the reference dependencies first, or " +
        "import another ontology to align."
    );
  return onto;
}

function referenceTitle(projectId: string): string {
  return getReference(projectId).meta.ontology.title;
}

function loadImported(id: string): {
  classes: OntoClass[];
  content: string;
  name: string;
  ext: string;
  store: Store;
} {
  const { content, ext, name } = ontologySource(id);
  const store = loadStore(content, ext);
  const { classes } = parseClasses(store);
  return { classes, content, name, ext, store };
}

/* ------------- Graphe d'une ontologie importée (onglet Graph) ------ */
/* Même forme que le graphe de la référence ; en version « mapped », les
   axiomes de liaison deviennent des arêtes vers les IRIs de la référence
   (le frontend fusionne les deux graphes).                              */

export interface WsGraph {
  nodes: {
    id: string;
    label: string;
    module: string;
    lobes: string[];
    comment?: string;
    external: boolean;
    degree: number;
    attributes: never[];
    /** nom court de l'ontologie importée (couleur + filtre côté frontend) */
    source: string;
  }[];
  links: {
    source: string;
    target: string;
    type: "subclass" | "property";
    label?: string;
    iri?: string;
    /** true = axiome de liaison vers la référence (mode « linked ») */
    mapping?: boolean;
  }[];
}

// Caches mémoire : le parsing TTL et les embeddings d'une ontologie importée
// ne changent qu'à la ré-importation (nouvel id) ou après un mapping.
const wsGraphCache = new Map<string, WsGraph>();
const wsEmbCache = new Map<string, number[][]>();
const wsClassCache = new Map<string, OntoClass[]>();

export function forgetOntologyCaches(id: string): void {
  wsGraphCache.delete(`${id}:original`);
  wsGraphCache.delete(`${id}:mapped`);
  wsEmbCache.delete(id);
  wsClassCache.delete(id);
}

export function ontologyGraph(
  projectId: string,
  id: string,
  version: "original" | "mapped"
): WsGraph {
  const onto = getOntology(id);
  if (!onto || onto.projectId !== projectId)
    throw new HttpError(404, "Unknown ontology in this project");
  const cacheKey = `${id}:${version}`;
  const cached = wsGraphCache.get(cacheKey);
  if (cached) return cached;

  let content: string;
  let ext: string;
  if (version === "mapped") {
    const path = mappedFilePath(id);
    if (!path)
      throw new HttpError(400, "No mapping generated yet — run Map to reference first");
    content = readFileSync(path, "utf8");
    ext = "ttl";
  } else {
    const src = ontologySource(id);
    content = src.content;
    ext = src.ext;
  }
  const store = loadStore(content, ext);
  const { classes } = parseClasses(store);
  const classSet = new Set(classes.map((c) => c.iri));
  const source = onto.name.replace(/\.[^.]+$/, "");
  // Cibles de mapping valides = nœuds du graphe de référence : tester
  // l'appartenance réelle évite les arêtes pendantes.
  const refNodeIds = new Set(getReference(projectId).graph.nodes.map((n) => n.id));

  const links: WsGraph["links"] = [];
  const seen = new Set<string>();
  const push = (l: WsGraph["links"][number]) => {
    const k = `${l.type}|${l.iri ?? l.label ?? ""}|${l.source}|${l.target}`;
    if (seen.has(k)) return;
    seen.add(k);
    links.push(l);
  };

  // Hiérarchie interne + axiomes de subsomption vers la référence
  for (const b of select(
    store,
    `SELECT ?s ?o WHERE { ?s rdfs:subClassOf ?o . FILTER(isIRI(?s) && isIRI(?o)) }`
  )) {
    const s = b.get("s")!.value;
    const o = b.get("o")!.value;
    if (!classSet.has(s) || s === o) continue;
    if (classSet.has(o)) {
      push({ source: s, target: o, type: "subclass", label: "subClassOf" });
    } else if (refNodeIds.has(o)) {
      push({
        source: s,
        target: o,
        type: "property",
        label: "⊑ subClassOf (reference)",
        iri: "http://www.w3.org/2000/01/rdf-schema#subClassOf",
        mapping: true,
      });
    }
  }
  // Axiomes d'équivalence / proximité vers la référence (SKOS pour les
  // mappings récents ; owl:equivalentClass conservé pour les anciens fichiers)
  const MAPPING_PREDICATES: [string, string, string][] = [
    ["skos:exactMatch", "≡ exactMatch", "http://www.w3.org/2004/02/skos/core#exactMatch"],
    ["skos:broadMatch", "⊑ broadMatch", "http://www.w3.org/2004/02/skos/core#broadMatch"],
    ["skos:closeMatch", "≈ closeMatch", "http://www.w3.org/2004/02/skos/core#closeMatch"],
    ["owl:equivalentClass", "≡ equivalentClass", "http://www.w3.org/2002/07/owl#equivalentClass"],
  ];
  for (const [pred, label, iri] of MAPPING_PREDICATES) {
    for (const b of select(
      store,
      `SELECT ?s ?o WHERE { ?s ${pred} ?o . FILTER(isIRI(?s) && isIRI(?o)) }`
    )) {
      const s = b.get("s")!.value;
      const o = b.get("o")!.value;
      if (!classSet.has(s)) continue;
      if (refNodeIds.has(o) || classSet.has(o)) {
        push({ source: s, target: o, type: "property", label, iri, mapping: true });
      }
    }
  }
  // Propriétés objet internes (domain -> range)
  for (const b of select(
    store,
    `SELECT DISTINCT ?p ?label ?d ?r WHERE {
       ?p a owl:ObjectProperty . FILTER(isIRI(?p))
       ?p rdfs:domain ?d . FILTER(isIRI(?d))
       ?p rdfs:range ?r . FILTER(isIRI(?r))
       OPTIONAL { ?p rdfs:label ?label }
     }`
  )) {
    const d = b.get("d")!.value;
    const r = b.get("r")!.value;
    const iri = b.get("p")!.value;
    if (!classSet.has(d) || !classSet.has(r)) continue;
    push({
      source: d,
      target: r,
      type: "property",
      label: b.get("label")?.value ?? localName(iri),
      iri,
    });
  }

  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  const graph: WsGraph = {
    nodes: classes.map((c) => ({
      id: c.iri,
      label: c.label,
      module: source,
      lobes: [],
      comment: c.comment,
      external: false,
      degree: degree.get(c.iri) ?? 0,
      attributes: [] as never[],
      source,
    })),
    links,
  };
  wsGraphCache.set(cacheKey, graph);
  return graph;
}

/* ------ Contexte chatbot : fiches des ontologies sélectionnées ------ */
/* Chaque classe importée devient une fiche (avec son lien vers la
   référence issu du mapping) + son embedding.                          */

const REL_SYMBOL: Record<string, string> = {
  equivalent: "≡ equivalent to",
  subclass: "⊑ subclass of",
  related: "≈ close match of",
};

export async function contextIndex(
  projectId: string,
  ids: string[]
): Promise<ExtraIndex | null> {
  const cards: Card[] = [];
  const vectors: Float32Array[] = [];
  const refTitle = referenceTitle(projectId);
  // Plafond de sécurité : 16 ontologies × ≤300 classes = ~4800 fiches max,
  // le scan cosinus reste en millisecondes.
  for (const id of ids.slice(0, 16)) {
    const onto = getOntology(id);
    // Les ontologies de la référence sont déjà dans l'index principal :
    // les rajouter dupliquerait leurs fiches dans le retrieval.
    if (!onto || onto.projectId !== projectId || onto.inReference) continue;
    let classes = wsClassCache.get(id);
    if (!classes) {
      classes = loadImported(id).classes;
      wsClassCache.set(id, classes);
    }
    const subset = classes.slice(0, MAX_CLASSES);
    let embs = wsEmbCache.get(id);
    if (!embs || embs.length !== subset.length) {
      embs = await embedTexts(subset.map((c) => c.text));
      wsEmbCache.set(id, embs);
    }
    const mapping = getResult(id, "mapping") as MappingReport | null;
    const linkOf = new Map(
      (mapping?.entries ?? [])
        .filter((e) => e.relation !== "none")
        .map((e) => [e.sourceIri, e])
    );
    const source = onto.name.replace(/\.[^.]+$/, "");
    subset.forEach((c, k) => {
      const link = linkOf.get(c.iri);
      const linkText = mapping
        ? link
          ? `\nLinked to ${refTitle}: ${REL_SYMBOL[link.relation]} ${link.target} (<${link.targetIri}>)`
          : `\nNot linked to ${refTitle} (no good match found).`
        : "";
      cards.push({
        iri: c.iri,
        label: c.label,
        module: source,
        kind: "class",
        text: `[Imported ontology: ${source}]\n${c.text}${linkText}`,
        tokens: new Set(tokenize(`${c.label} ${c.iri} ${c.comment ?? ""}`)),
      });
      vectors.push(Float32Array.from(embs![k]));
    });
  }
  return cards.length > 0 ? { cards, vectors } : null;
}

/* ------------------ Index structurel de la référence ---------------- */
/* Profils (labels normalisés, altLabels, parents, voisins) + index BM25
   où chaque classe est un « document ». Construit une fois par projet.  */

interface RefStructure {
  profiles: Map<string, EntityProfile>;
  bm25: Bm25Index;
  docIdx: Map<string, number>;
  /** label normalisé -> IRIs : candidats lexicaux exacts hors top cosinus */
  byNorm: Map<string, string[]>;
}
const structCache = new Map<string, RefStructure>();
onProjectInvalidated((projectId) => structCache.delete(projectId));

function refStructure(projectId: string): RefStructure {
  const cached = structCache.get(projectId);
  if (cached) return cached;
  const ref = getReference(projectId);
  const { nodes, links } = ref.graph;
  const labelOf = new Map(nodes.map((n) => [n.id, n.label]));
  const cap = (list: string[], v: string, max: number) => {
    if (list.length < max && !list.includes(v)) list.push(v);
  };
  const supers = new Map<string, string[]>();
  const neigh = new Map<string, string[]>();
  const at = (m: Map<string, string[]>, k: string) => {
    let l = m.get(k);
    if (!l) m.set(k, (l = []));
    return l;
  };
  for (const l of links) {
    const sl = labelOf.get(l.source);
    const tl = labelOf.get(l.target);
    if (!sl || !tl) continue;
    cap(at(neigh, l.source), tl, 24);
    cap(at(neigh, l.target), sl, 24);
    if (l.type === "subclass") cap(at(supers, l.source), tl, 8);
  }
  // altLabels de la référence (si le vocabulaire en déclare)
  const alts = new Map<string, string[]>();
  try {
    for (const b of select(
      ref.store,
      `SELECT ?c ?alt WHERE { ?c skos:altLabel ?alt }`
    )) {
      const c = b.get("c")?.value;
      const alt = b.get("alt")?.value;
      if (c && alt) cap(at(alts, c), alt, 8);
    }
  } catch {
    /* pas d'altLabels : la métrique synonymes restera indisponible */
  }
  const profiles = new Map<string, EntityProfile>();
  const docIdx = new Map<string, number>();
  const byNorm = new Map<string, string[]>();
  const docs: string[][] = [];
  for (const n of nodes) {
    const prof = makeProfile({
      label: n.label,
      localName: localName(n.id),
      altLabels: alts.get(n.id),
      comment: n.comment,
      superLabels: supers.get(n.id),
      neighborLabels: neigh.get(n.id),
    });
    profiles.set(n.id, prof);
    docIdx.set(n.id, docs.length);
    docs.push([
      ...labelTokens(n.label),
      ...labelTokens(n.comment ?? ""),
      ...(supers.get(n.id) ?? []).flatMap(labelTokens),
      ...(neigh.get(n.id) ?? []).flatMap(labelTokens),
    ]);
    at(byNorm, prof.norm).push(n.id);
  }
  const struct: RefStructure = { profiles, bm25: new Bm25Index(docs), docIdx, byNorm };
  structCache.set(projectId, struct);
  console.log(
    `[workspace] index structurel de ${ref.meta.ontology.title}: ${profiles.size} profils`
  );
  return struct;
}

function wsProfileOf(wc: OntoClass): EntityProfile {
  return makeProfile({
    label: wc.label,
    localName: localName(wc.iri),
    altLabels: wc.alts,
    comment: wc.comment,
    superLabels: wc.supers,
    neighborLabels: wc.neighbors,
  });
}

interface MatchCandidate {
  iri: string;
  label: string;
  module: string;
  /** score global agrégé (= facets.aggregated) */
  score: number;
  facets: FacetScores;
}

/* Présélection par cosinus (rapide sur toute la référence), puis notation
   multi-facettes des meilleurs candidats seulement. */
const PRESELECT = 12;

async function bestRefMatches(
  projectId: string,
  classes: OntoClass[],
  cacheKey?: string
): Promise<{ perClass: MatchCandidate[][]; truncated: number }> {
  const { cards, vectors } = await referenceIndex(projectId);
  const struct = refStructure(projectId);
  const classIdx: number[] = [];
  const idxByIri = new Map<string, number>();
  cards.forEach((c, i) => {
    if (c.kind === "class") {
      classIdx.push(i);
      idxByIri.set(c.iri, i);
    }
  });

  const truncated = Math.max(0, classes.length - MAX_CLASSES);
  const subset = classes.slice(0, MAX_CLASSES);
  let embs = cacheKey ? wsEmbCache.get(cacheKey) : undefined;
  if (!embs || embs.length !== subset.length) {
    embs = await embedTexts(subset.map((c) => c.text));
    if (cacheKey) wsEmbCache.set(cacheKey, embs);
  }

  const perClass: MatchCandidate[][] = subset.map((wc, k) => {
    const v = Float32Array.from(embs[k]);
    const wcProfile = wsProfileOf(wc);
    const queryTokens = [
      ...labelTokens(wc.label),
      ...labelTokens(wc.comment ?? ""),
      ...wc.supers.flatMap(labelTokens),
    ];
    // 1. présélection : top cosinus + candidats à label identique
    const byCos = classIdx
      .map((i) => ({ i, c: cosine(v, vectors[i]) }))
      .sort((x, y) => y.c - x.c);
    const picked = new Map<number, number>();
    for (const { i, c } of byCos.slice(0, PRESELECT)) picked.set(i, c);
    if (wcProfile.norm.length > 2) {
      for (const iri of struct.byNorm.get(wcProfile.norm) ?? []) {
        const i = idxByIri.get(iri);
        if (i !== undefined && !picked.has(i)) picked.set(i, cosine(v, vectors[i]));
      }
    }
    // 2. notation multi-facettes + re-classement. Le BM25 est renormalisé
    // par rapport au pool de candidats (le meilleur ≈ 1) : la borne
    // supérieure théorique est inatteignable dès que la définition
    // importée emploie des mots absents du corpus de référence, ce qui
    // écrasait tous les scores. Plancher 0.2 : si tout le pool est faible,
    // on ne gonfle pas artificiellement le moins mauvais.
    const pool: { i: number; cos: number; bm25raw?: number }[] = [];
    for (const [i, cos] of picked) {
      const d = struct.docIdx.get(cards[i].iri);
      pool.push({
        i,
        cos,
        bm25raw: d !== undefined ? struct.bm25.score(queryTokens, d) : undefined,
      });
    }
    const bm25Max = Math.max(0.2, ...pool.map((p) => p.bm25raw ?? 0));
    const scored: MatchCandidate[] = [];
    for (const { i, cos, bm25raw } of pool) {
      const card = cards[i];
      const prof = struct.profiles.get(card.iri);
      if (!prof) continue;
      const facets = compareEntities(wcProfile, prof, {
        contextual: cos,
        bm25: bm25raw !== undefined ? Math.min(1, bm25raw / bm25Max) : undefined,
      });
      scored.push({
        iri: card.iri,
        label: card.label,
        module: card.module,
        score: facets.aggregated,
        facets,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3);
  });
  return { perClass, truncated };
}

/* --------------------------- Comparaison --------------------------- */

/** Scores par facette arrondis pour les rapports JSON. */
export interface FacetSummary {
  lexical: number;
  structural?: number;
  semantic?: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function facetSummary(f: FacetScores): FacetSummary {
  return {
    lexical: r3(f.lexical),
    structural: f.structural !== undefined ? r3(f.structural) : undefined,
    semantic: f.semantic !== undefined ? r3(f.semantic) : undefined,
  };
}

/* Seuils sur le score AGRÉGÉ (calibré plus bas que le cosinus seul :
   la facette structurelle tire les scores vers le bas). */
const STRONG_AT = 0.7;
const MEDIUM_AT = 0.55;

export interface CompareReport {
  createdAt: number;
  totalClasses: number;
  analyzed: number;
  truncated: number;
  /** Similarité moyenne à la référence (0-100), avant vérification LLM */
  similarityScore: number;
  buckets: { strong: number; medium: number; weak: number };
  matches: {
    source: string;
    sourceIri: string;
    target: string;
    targetIri: string;
    module: string;
    score: number;
    facets?: FacetSummary;
  }[];
}

export async function compareToReference(
  projectId: string,
  id: string
): Promise<CompareReport> {
  loadTarget(projectId, id);

  if (EXTERNAL_SIM_BASE) {
    try {
      const report = await compareToReferenceExternal(projectId, id);
      saveResult(id, "compare", report);
      return report;
    } catch (e) {
      console.warn(`[workspace] external similarity compare failed, falling back to local: ${(e as Error).message}`);
    }
  }

  const { classes } = loadImported(id);
  const { perClass, truncated } = await bestRefMatches(projectId, classes, id);
  const buckets = { strong: 0, medium: 0, weak: 0 };
  const matches: CompareReport["matches"] = [];
  perClass.forEach((cands, k) => {
    const best = cands[0];
    if (!best) return;
    if (best.score >= STRONG_AT) buckets.strong++;
    else if (best.score >= MEDIUM_AT) buckets.medium++;
    else buckets.weak++;
    matches.push({
      source: classes[k].label,
      sourceIri: classes[k].iri,
      target: best.label,
      targetIri: best.iri,
      module: best.module,
      score: r3(best.score),
      facets: facetSummary(best.facets),
    });
  });
  matches.sort((a, b) => b.score - a.score);
  const avg =
    matches.length > 0 ? matches.reduce((s, m) => s + m.score, 0) / matches.length : 0;
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
  /** score agrégé du candidat retenu */
  score?: number;
  /** scores par facette (lexical / structurel / sémantique) */
  facets?: FacetSummary;
  /** centralité de la classe dans son ontologie (0-1) */
  importance?: number;
}

export interface MappingReport {
  createdAt: number;
  totalClasses: number;
  truncated: number;
  /** Score de liaison à la référence (0-100) : couverture pondérée */
  linkScore: number;
  counts: { equivalent: number; subclass: number; related: number; none: number };
  entries: MappingEntry[];
  file: string;
  /** export SSSOM TSV (mêmes mappings, format d'échange standard) */
  sssomFile?: string;
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
    (acc, e) => acc + W[e.relation] * (e.relation === "none" ? 0 : (e.confidence ?? 0.7)),
    0
  );
  return Math.round((sum / entries.length) * 100);
}

/* Le mapping n'utilise QUE des prédicats SKOS : contrairement à
   owl:equivalentClass / rdfs:subClassOf, ils ne modifient pas la
   sémantique inférée de la référence. */
const REL_PROP: Record<string, string> = {
  equivalent: "http://www.w3.org/2004/02/skos/core#exactMatch",
  subclass: "http://www.w3.org/2004/02/skos/core#broadMatch",
  related: "http://www.w3.org/2004/02/skos/core#closeMatch",
};

const fmtFacets = (f: FacetScores): string => {
  const p = (x: number | undefined) => (x !== undefined ? x.toFixed(2) : "n/a");
  return `lexical ${p(f.lexical)}, structural ${p(f.structural)}, semantic ${p(f.semantic)}, overall ${p(f.aggregated)}`;
};

async function verifyBatch(
  refTitle: string,
  refDescription: string,
  items: { wc: OntoClass; cands: MatchCandidate[] }[],
  refCardByIri: Map<string, Card>
): Promise<MappingEntry[]> {
  const about = refDescription
    ? `${refTitle} (${refDescription.replace(/\s+/g, " ").slice(0, 200)})`
    : refTitle;
  const sys =
    `You align classes of an external ontology onto ${about}, the reference ` +
    "ontology of the current project. For EACH item decide:\n" +
    '- "equivalent": same concept as the reference candidate\n' +
    '- "subclass": the external class is a MORE SPECIFIC kind of the candidate\n' +
    '- "related": clearly related but neither equivalent nor a subclass\n' +
    '- "none": no candidate fits — the class stays unlinked\n' +
    "Each candidate has similarity scores from independent matchers " +
    "(lexical = string metrics, structural = graph neighborhood, semantic = " +
    "embeddings). High lexical with low structural often means a FALSE FRIEND " +
    "(same name, different concept); high structural+semantic with low lexical " +
    "can still be a true match under a different name.\n" +
    "Be conservative: prefer none over a wrong link. Use ONLY the provided " +
    "candidate IRIs. Reply with a STRICT JSON array, one object per item, " +
    'same order: [{"i":0,"relation":"equivalent","target":"<candidate iri>","confidence":0.9}] ' +
    '(omit target for "none"). No other text.';
  const user = items
    .map(({ wc, cands }, i) => {
      const cs = cands
        .map((c) => {
          const card = refCardByIri.get(c.iri);
          const def = card?.text.match(/Definition: (.*)/)?.[1]?.slice(0, 180);
          return `  - ${c.iri} — ${c.label}${def ? ` : ${def}` : ""} [${fmtFacets(c.facets)}]`;
        })
        .join("\n");
      return `Item ${i}:\nExternal class:\n${wc.text.slice(0, 400)}\nReference candidates:\n${cs}`;
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
    const v = parsed.find((p) => Number(p?.i) === i);
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
      score: r3(cand.score),
      facets: facetSummary(cand.facets),
    };
  });
}

/* SSSOM : justification unique (matchers composés + vérification LLM). */
const SSSOM_JUSTIFICATION = "semapv:CompositeMatching";
const SKOS_NS = "http://www.w3.org/2004/02/skos/core#";
const ALIGN_NS = "https://w3id.org/ontology-explorer/alignment#";

const relCurie = (relation: MappingEntry["relation"]): string =>
  `skos:${REL_PROP[relation].slice(SKOS_NS.length)}`;

/** Bloc Turtle : axiomes SKOS directs + réification owl:Axiom portant les
    métadonnées SSSOM (confiance, score global, scores par facette).      */
function alignmentTurtle(
  name: string,
  refTitle: string,
  entries: MappingEntry[],
  linked: MappingEntry[]
): string {
  const safe = (s: string) => s.replace(/[\n\r]+/g, " ");
  const lines: string[] = [];
  lines.push("");
  lines.push("#################################################################");
  lines.push(`# Alignment to ${safe(refTitle)} — generated ${new Date().toISOString()}`);
  lines.push(
    `# Source: ${safe(name)} · ${linked.length}/${entries.length} classes linked`
  );
  lines.push("# SKOS mapping axioms only (the reference's inferred semantics are");
  lines.push("# NOT modified), each reified as owl:Axiom with SSSOM metadata:");
  lines.push("# confidence (LLM verifier), similarity_score (aggregated) and");
  lines.push("# per-facet scores (lexical / structural / semantic).");
  lines.push("#################################################################");
  lines.push("@prefix owl: <http://www.w3.org/2002/07/owl#> .");
  lines.push("@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .");
  lines.push(`@prefix skos: <${SKOS_NS}> .`);
  lines.push("@prefix sssom: <https://w3id.org/sssom/> .");
  lines.push("@prefix semapv: <https://w3id.org/semapv/vocab/> .");
  lines.push(`@prefix align: <${ALIGN_NS}> .`);
  const dbl = (x: number) => `"${x.toFixed(3)}"^^xsd:double`;
  for (const e of linked) {
    lines.push("");
    lines.push(`<${e.sourceIri}> ${relCurie(e.relation)} <${e.targetIri}> .`);
    lines.push("[] a owl:Axiom ;");
    lines.push(`   owl:annotatedSource <${e.sourceIri}> ;`);
    lines.push(`   owl:annotatedProperty ${relCurie(e.relation)} ;`);
    lines.push(`   owl:annotatedTarget <${e.targetIri}> ;`);
    lines.push(`   sssom:mapping_justification ${SSSOM_JUSTIFICATION} ;`);
    const props: string[] = [];
    if (e.confidence !== undefined) props.push(`   sssom:confidence ${dbl(e.confidence)}`);
    if (e.score !== undefined) props.push(`   sssom:similarity_score ${dbl(e.score)}`);
    if (e.facets) {
      props.push(`   align:lexicalSimilarity ${dbl(e.facets.lexical)}`);
      if (e.facets.structural !== undefined)
        props.push(`   align:structuralSimilarity ${dbl(e.facets.structural)}`);
      if (e.facets.semantic !== undefined)
        props.push(`   align:semanticSimilarity ${dbl(e.facets.semantic)}`);
    }
    if (e.importance !== undefined)
      props.push(`   align:importanceScore ${dbl(e.importance)}`);
    lines.push(props.join(" ;\n") + " .");
  }
  return lines.join("\n");
}

/** Export SSSOM TSV (format d'échange standard des mappings). */
function sssomTsv(
  id: string,
  name: string,
  refTitle: string,
  linked: MappingEntry[]
): string {
  const esc = (s: string) => s.replace(/[\t\n\r]+/g, " ").trim();
  const lines: string[] = [
    "# curie_map:",
    `#   skos: ${SKOS_NS}`,
    "#   semapv: https://w3id.org/semapv/vocab/",
    `# mapping_set_id: urn:uuid:${id}`,
    `# mapping_set_description: Alignment of "${esc(name).replace(/"/g, "'")}" onto ${esc(refTitle)}`,
    "# mapping_tool: Ontology Explorer",
    `# mapping_date: "${new Date().toISOString().slice(0, 10)}"`,
    "# license: https://w3id.org/sssom/license/unspecified",
    [
      "subject_id",
      "subject_label",
      "predicate_id",
      "object_id",
      "object_label",
      "mapping_justification",
      "confidence",
      "similarity_score",
    ].join("\t"),
  ];
  for (const e of linked) {
    lines.push(
      [
        e.sourceIri,
        esc(e.source),
        relCurie(e.relation),
        e.targetIri ?? "",
        esc(e.target ?? ""),
        SSSOM_JUSTIFICATION,
        e.confidence !== undefined ? e.confidence.toFixed(3) : "",
        e.score !== undefined ? e.score.toFixed(3) : "",
      ].join("\t")
    );
  }
  return lines.join("\n") + "\n";
}

export function mappedFilePath(id: string): string | null {
  if (!VALID_ID.test(id)) return null;
  const p = join(WS_DIR, `${id}-mapped.ttl`);
  return existsSync(p) ? p : null;
}

export function sssomFilePath(id: string): string | null {
  if (!VALID_ID.test(id)) return null;
  const p = join(WS_DIR, `${id}-mappings.sssom.tsv`);
  return existsSync(p) ? p : null;
}

/** Contenu Turtle de base : les sources non-Turtle sont converties, car on
    y concatène des triples Turtle. */
function turtleBase(content: string, ext: string, store: Store): string {
  if (ext === "ttl" || ext === "n3" || ext === "nt") return content;
  return dumpTurtle(store);
}

export async function mapToReference(
  projectId: string,
  id: string
): Promise<MappingReport> {
  loadTarget(projectId, id);

  if (EXTERNAL_SIM_BASE) {
    try {
      const report = await mapToReferenceExternal(projectId, id);
      saveResult(id, "mapping", report);
      return report;
    } catch (e) {
      console.warn(`[workspace] external similarity map failed, falling back to local: ${(e as Error).message}`);
    }
  }

  const ref = getReference(projectId);
  const refTitle = ref.meta.ontology.title;
  const { classes, content, name, ext, store } = loadImported(id);
  const { perClass, truncated } = await bestRefMatches(projectId, classes, id);
  const refCardByIri = new Map((await referenceIndex(projectId)).cards.map((c) => [c.iri, c]));

  /* Importance : centralité (degré normalisé) dans l'ontologie importée.
     Sert à vérifier les concepts centraux en premier (un échec API en
     cours de route sacrifie d'abord les classes périphériques). */
  const maxDegree = classes.reduce((m, c) => Math.max(m, c.degree), 1);
  const importanceOf = (wc: OntoClass) => r3(wc.degree / maxDegree);

  // Vérification LLM uniquement pour les candidats plausibles : score
  // agrégé correct OU signal sémantique seul déjà fort (le structurel
  // peut plomber l'agrégé d'un vrai match sous un autre nom).
  const toVerify: { wc: OntoClass; cands: MatchCandidate[] }[] = [];
  const entries: MappingEntry[] = [];
  perClass.forEach((cands, k) => {
    const best = cands[0];
    if (best && (best.score >= 0.5 || (best.facets.detail.contextual ?? 0) >= 0.55)) {
      toVerify.push({ wc: classes[k], cands });
    } else {
      entries.push({
        source: classes[k].label,
        sourceIri: classes[k].iri,
        relation: "none",
        importance: importanceOf(classes[k]),
      });
    }
  });
  toVerify.sort((a, b) => b.wc.degree - a.wc.degree);
  const importanceByIri = new Map(classes.map((c) => [c.iri, importanceOf(c)]));
  const BATCH = 8;
  for (let i = 0; i < toVerify.length; i += BATCH) {
    const batch = toVerify.slice(i, i + BATCH);
    try {
      entries.push(
        ...(
          await verifyBatch(refTitle, ref.meta.ontology.description, batch, refCardByIri)
        ).map((e) => ({ ...e, importance: importanceByIri.get(e.sourceIri) }))
      );
    } catch (e) {
      // Un lot en échec (API indisponible…) ne doit pas faire perdre le
      // mapping entier : ses classes restent non liées.
      console.warn(`[workspace] lot de vérification en échec: ${(e as Error).message}`);
      entries.push(
        ...batch.map(({ wc }) => ({
          source: wc.label,
          sourceIri: wc.iri,
          relation: "none" as const,
          importance: importanceByIri.get(wc.iri),
        }))
      );
    }
    console.log(
      `[workspace] mapping ${Math.min(i + BATCH, toVerify.length)}/${toVerify.length} classes vérifiées`
    );
  }

  /* --- Nouvelle ontologie : copie de l'importée + axiomes vers la réf --- */
  const linked = entries.filter((e) => e.relation !== "none");
  const mapped =
    turtleBase(content, ext, store).trimEnd() +
    "\n" +
    alignmentTurtle(name, refTitle, entries, linked) +
    "\n";
  loadStore(mapped, "ttl"); // validation : le résultat doit se parser
  writeFileSync(join(WS_DIR, `${id}-mapped.ttl`), mapped, "utf8");
  writeFileSync(
    join(WS_DIR, `${id}-mappings.sssom.tsv`),
    sssomTsv(id, name, refTitle, linked),
    "utf8"
  );
  wsGraphCache.delete(`${id}:mapped`); // le fichier mappé vient de changer

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
    sssomFile: `${id}-mappings.sssom.tsv`,
  };
  saveResult(id, "mapping", report);
  return report;
}
