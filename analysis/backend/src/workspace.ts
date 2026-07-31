import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import oxigraph from "oxigraph";
import { db, DATA_DIR } from "./chatstore.js";
import {
  Card,
  ExtraIndex,
  chatConfig,
  cosine,
  drIndex,
  embedTexts,
  llmCall,
  tokenize,
} from "./chat.js";
import { getFullGraph, store as drStore } from "./ontology.js";
import {
  Bm25Index,
  EntityProfile,
  FacetScores,
  compareEntities,
  labelTokens,
  makeProfile,
} from "./similarity.js";

/* ------------------------------------------------------------------ */
/* Workspace : ontologies importées par l'utilisateur                  */
/*  - persistance : fichiers dans analysis/.data/workspace/ + SQLite   */
/*  - comparaison au Digital Reference : similarité multi-facettes     */
/*    (lexicale + structurelle + sémantique, voir similarity.ts)       */
/*  - mapping : nouvelle ontologie = copie de l'importée + axiomes     */
/*    SKOS vers le DR (exactMatch / broadMatch / closeMatch) réifiés   */
/*    avec leurs scores (vocabulaire SSSOM) + export .sssom.tsv.       */
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
  /** labels alternatifs (skos:altLabel / prefLabel) — métrique synonymes */
  alts: string[];
  /** labels des voisins directs (hiérarchie + propriétés objet) */
  neighbors: string[];
  /** degré dans l'ontologie importée (centralité → importance score) */
  degree: number;
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
      c = { iri, label: localName(iri), supers: [], alts: [], neighbors: [], degree: 0, text: "" };
      byIri.set(iri, c);
    }
    const label = b.get("label");
    if (label && (c.label === localName(iri) || label.language === "en"))
      c.label = label.value;
    const comment = b.get("comment");
    if (comment && (!c.comment || comment.language === "en"))
      c.comment = comment.value;
  }
  // Labels alternatifs (synonymes déclarés)
  for (const b of q(
    `SELECT ?c ?alt WHERE {
       { ?c skos:altLabel ?alt } UNION { ?c skos:prefLabel ?alt }
     }`
  )) {
    const c = byIri.get(b.get("c")!.value);
    const alt = b.get("alt")?.value;
    if (c && alt && alt !== c.label && c.alts.length < 8 && !c.alts.includes(alt))
      c.alts.push(alt);
  }
  const addNeighbor = (c: WsClass, label: string) => {
    c.degree++;
    if (c.neighbors.length < 24 && !c.neighbors.includes(label))
      c.neighbors.push(label);
  };
  for (const b of q(
    `SELECT ?s ?o WHERE { ?s rdfs:subClassOf ?o . FILTER(isIRI(?s) && isIRI(?o)) }`
  )) {
    const c = byIri.get(b.get("s")!.value);
    const o = byIri.get(b.get("o")!.value);
    if (!c || !o) continue;
    if (c.supers.length < 6) c.supers.push(o.label);
    addNeighbor(c, o.label);
    addNeighbor(o, c.label);
  }
  // Propriétés objet : domain -> range = voisinage structurel
  for (const b of q(
    `SELECT ?d ?r WHERE {
       ?p a owl:ObjectProperty .
       ?p rdfs:domain ?d . FILTER(isIRI(?d))
       ?p rdfs:range ?r . FILTER(isIRI(?r))
     }`
  )) {
    const dc = byIri.get(b.get("d")!.value);
    const rc = byIri.get(b.get("r")!.value);
    if (!dc || !rc || dc === rc) continue;
    addNeighbor(dc, rc.label);
    addNeighbor(rc, dc.label);
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
  for (const f of [row.filename, `${id}-mapped.ttl`, `${id}-mappings.sssom.tsv`]) {
    try {
      if (existsSync(join(WS_DIR, f))) unlinkSync(join(WS_DIR, f));
    } catch {
      /* fichier fantôme : la ligne DB part quand même */
    }
  }
  db.prepare(`DELETE FROM ws_results WHERE onto_id = ?`).run(id);
  db.prepare(`DELETE FROM ws_ontologies WHERE id = ?`).run(id);
  wsGraphCache.delete(`${id}:original`);
  wsGraphCache.delete(`${id}:mapped`);
  wsEmbCache.delete(id);
  wsClassCache.delete(id);
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

/* ------------- Graphe d'une ontologie importée (onglet Graph) ------ */
/* Même forme que le graphe du DR ; en version « mapped », les axiomes de
   liaison deviennent des arêtes vers les IRIs du DR (le frontend fusionne
   les deux graphes, les liens retrouvent donc leurs cibles).             */

/* Cibles de mapping valides = nœuds du graphe DR fusionné côté frontend
   (y compris les classes « externes » hors préfixe ecsel-dr). Tester
   l'appartenance réelle évite les arêtes pendantes ET ne rate aucun
   namespace du DR. */
let drNodeIdsCache: Set<string> | null = null;
function drNodeIds(): Set<string> {
  if (!drNodeIdsCache)
    drNodeIdsCache = new Set(getFullGraph().nodes.map((n) => n.id));
  return drNodeIdsCache;
}

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
    /** true = axiome de liaison vers le DR (visible en mode « linked » seulement) */
    mapping?: boolean;
  }[];
}

// Caches mémoire : le parsing TTL et les embeddings d'une ontologie importée
// ne changent qu'à la ré-importation (nouvel id) ou après un mapping.
const wsGraphCache = new Map<string, WsGraph>();
const wsEmbCache = new Map<string, number[][]>();
const wsClassCache = new Map<string, WsClass[]>();

export function ontologyGraph(id: string, version: "original" | "mapped"): WsGraph {
  const cacheKey = `${id}:${version}`;
  const cached = wsGraphCache.get(cacheKey);
  if (cached) return cached;
  const row = db
    .prepare(`SELECT name, filename FROM ws_ontologies WHERE id = ?`)
    .get(id) as { name: string; filename: string } | undefined;
  if (!row) throw new Error("Unknown ontology");
  let content: string;
  let ext: string;
  if (version === "mapped") {
    const path = mappedFilePath(id);
    if (!path) throw new Error("No mapping generated yet — run Map to DR first");
    content = readFileSync(path, "utf8");
    ext = "ttl";
  } else {
    content = readFileSync(join(WS_DIR, row.filename), "utf8");
    ext = (row.filename.split(".").pop() ?? "ttl").toLowerCase();
  }
  const store = loadStore(content, ext);
  const { classes } = parseClasses(store);
  const classSet = new Set(classes.map((c) => c.iri));
  const source = row.name.replace(/\.[^.]+$/, "");

  type Term = { termType: string; value: string };
  type Binding = Map<string, Term>;
  const q = (sparql: string) =>
    store.query(
      `PREFIX owl: <http://www.w3.org/2002/07/owl#>
       PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
       PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
       ${sparql}`
    ) as Binding[];

  const links: WsGraph["links"] = [];
  const seen = new Set<string>();
  const push = (l: WsGraph["links"][number]) => {
    const k = `${l.type}|${l.iri ?? l.label ?? ""}|${l.source}|${l.target}`;
    if (seen.has(k)) return;
    seen.add(k);
    links.push(l);
  };

  // Hiérarchie interne + axiomes de subsomption vers le DR (version mappée)
  for (const b of q(
    `SELECT ?s ?o WHERE { ?s rdfs:subClassOf ?o . FILTER(isIRI(?s) && isIRI(?o)) }`
  )) {
    const s = b.get("s")!.value;
    const o = b.get("o")!.value;
    if (!classSet.has(s) || s === o) continue;
    if (classSet.has(o)) {
      push({ source: s, target: o, type: "subclass", label: "subClassOf" });
    } else if (drNodeIds().has(o)) {
      push({
        source: s,
        target: o,
        type: "property",
        label: "⊑ subClassOf (DR)",
        iri: "http://www.w3.org/2000/01/rdf-schema#subClassOf",
        mapping: true,
      });
    }
  }
  // Axiomes d'équivalence / proximité vers le DR (SKOS pour les mappings
  // récents ; owl:equivalentClass conservé pour les fichiers anciens)
  const MAPPING_PREDICATES: [string, string, string][] = [
    ["skos:exactMatch", "≡ exactMatch (DR)", "http://www.w3.org/2004/02/skos/core#exactMatch"],
    ["skos:broadMatch", "⊑ broadMatch (DR)", "http://www.w3.org/2004/02/skos/core#broadMatch"],
    ["skos:closeMatch", "≈ closeMatch (DR)", "http://www.w3.org/2004/02/skos/core#closeMatch"],
    ["owl:equivalentClass", "≡ equivalentClass (DR)", "http://www.w3.org/2002/07/owl#equivalentClass"],
  ];
  for (const [pred, label, iri] of MAPPING_PREDICATES) {
    for (const b of q(
      `SELECT ?s ?o WHERE { ?s ${pred} ?o . FILTER(isIRI(?s) && isIRI(?o)) }`
    )) {
      const s = b.get("s")!.value;
      const o = b.get("o")!.value;
      if (!classSet.has(s)) continue;
      if (drNodeIds().has(o) || classSet.has(o)) {
        push({
          source: s,
          target: o,
          type: "property",
          label,
          iri,
          mapping: true,
        });
      }
    }
  }
  // Propriétés objet internes (domain -> range, sans owl:unionOf : les
  // ontologies importées simples suffisent pour la visualisation)
  for (const b of q(
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
/* Chaque classe importée devient une fiche (avec son lien DR issu du
   mapping) + son embedding (réutilisé du compare/map si déjà calculé).   */

const REL_SYMBOL: Record<string, string> = {
  equivalent: "≡ equivalent to",
  subclass: "⊑ subclass of",
  related: "≈ close match of",
};

export async function contextIndex(ids: string[]): Promise<ExtraIndex | null> {
  const cards: Card[] = [];
  const vectors: Float32Array[] = [];
  // Plafond de sécurité : 16 ontologies × ≤300 classes = ~4800 fiches max,
  // le scan cosinus reste en millisecondes.
  for (const id of ids.slice(0, 16)) {
    const row = db
      .prepare(`SELECT name FROM ws_ontologies WHERE id = ?`)
      .get(id) as { name: string } | undefined;
    if (!row) continue;
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
    const source = row.name.replace(/\.[^.]+$/, "");
    subset.forEach((c, k) => {
      const link = linkOf.get(c.iri);
      const linkText = mapping
        ? link
          ? `\nLinked to the Digital Reference: ${REL_SYMBOL[link.relation]} ${link.target} (<${link.targetIri}>)`
          : "\nNot linked to the Digital Reference (no good match found)."
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

/* --------------------- Similarité contre le DR --------------------- */

const MAX_CLASSES = 300;

/* Index structurel du DR : profils (labels normalisés, altLabels, parents,
   voisins) + index BM25 où chaque classe est un « document » (label +
   définition + contexte de graphe). Construit une fois, invalidé jamais
   (le DR ne change pas pendant la vie du process).                      */
interface DrStructure {
  profiles: Map<string, EntityProfile>;
  bm25: Bm25Index;
  docIdx: Map<string, number>;
  /** label normalisé -> IRIs : candidats lexicaux exacts hors top cosinus */
  byNorm: Map<string, string[]>;
}
let drStructCache: DrStructure | null = null;

function drStructure(): DrStructure {
  if (drStructCache) return drStructCache;
  const { nodes, links } = getFullGraph();
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
  // altLabels du DR (si le vocabulaire en déclare)
  const alts = new Map<string, string[]>();
  try {
    type Term = { value: string };
    for (const b of drStore.query(
      `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
       SELECT ?c ?alt WHERE { ?c skos:altLabel ?alt }`
    ) as Map<string, Term>[]) {
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
  drStructCache = { profiles, bm25: new Bm25Index(docs), docIdx, byNorm };
  console.log(`[workspace] index structurel DR: ${profiles.size} profils`);
  return drStructCache;
}

function wsProfileOf(wc: WsClass): EntityProfile {
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

/* Présélection par cosinus (rapide sur tout le DR), puis notation
   multi-facettes des meilleurs candidats seulement : le coût des
   métriques lexicales/structurelles reste en O(classes × PRESELECT). */
const PRESELECT = 12;

async function bestDrMatches(
  classes: WsClass[],
  cacheKey?: string
): Promise<{ perClass: MatchCandidate[][]; truncated: number }> {
  const { cards, vectors } = await drIndex();
  const struct = drStructure();
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
        if (i !== undefined && !picked.has(i))
          picked.set(i, cosine(v, vectors[i]));
      }
    }
    // 2. notation multi-facettes + re-classement. Le BM25 est renormalisé
    // par rapport au pool de candidats (le meilleur ≈ 1) : la borne
    // supérieure théorique est inatteignable dès que la définition
    // importée emploie des mots absents du corpus DR, ce qui écrasait
    // tous les scores. Plancher 0.2 : si tout le pool est faible, on ne
    // gonfle pas artificiellement le moins mauvais.
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
        bm25:
          bm25raw !== undefined ? Math.min(1, bm25raw / bm25Max) : undefined,
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
  console.log(
    "[workspace] bestDrMatches:",
    perClass.slice(0, 3).map((c, i) => `${subset[i].label}=${c[0]?.score?.toFixed(3)}`).join(" ")
  );
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
    facets?: FacetSummary;
  }[];
}

export async function compareToDr(id: string): Promise<CompareReport> {
  const { classes } = loadImported(id);
  const { perClass, truncated } = await bestDrMatches(classes, id);
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
  /** Score de liaison au DR (0-100) : couverture pondérée par relation et confiance */
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
    (acc, e) =>
      acc + W[e.relation] * (e.relation === "none" ? 0 : (e.confidence ?? 0.7)),
    0
  );
  return Math.round((sum / entries.length) * 100);
}

/* Le mapping n'utilise QUE des prédicats SKOS : contrairement à
   owl:equivalentClass / rdfs:subClassOf, ils ne modifient pas la
   sémantique inférée du DR (pas de nouvelles subsomptions déduites). */
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
          const card = drCardByIri.get(c.iri);
          const def = card?.text.match(/Definition: (.*)/)?.[1]?.slice(0, 180);
          return `  - ${c.iri} — ${c.label}${def ? ` : ${def}` : ""} [${fmtFacets(c.facets)}]`;
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

const relCurie = (relation: MappingEntry["relation"]): string =>
  `skos:${REL_PROP[relation].slice(SKOS_NS.length)}`;

/** Bloc Turtle : axiomes SKOS directs + réification owl:Axiom portant les
    métadonnées SSSOM (confiance, score global, scores par facette).      */
function alignmentTurtle(
  name: string,
  entries: MappingEntry[],
  linked: MappingEntry[]
): string {
  const safeName = name.replace(/[\n\r]+/g, " ");
  const lines: string[] = [];
  lines.push("");
  lines.push("#################################################################");
  lines.push(`# Alignment to the Digital Reference — generated ${new Date().toISOString()}`);
  lines.push(`# Source: ${safeName} · ${linked.length}/${entries.length} classes linked to the DR`);
  lines.push("# SKOS mapping axioms only (the DR's inferred semantics are NOT");
  lines.push("# modified), each reified as owl:Axiom with SSSOM metadata:");
  lines.push("# confidence (LLM verifier), similarity_score (aggregated) and");
  lines.push("# per-facet scores (lexical / structural / semantic).");
  lines.push("#################################################################");
  lines.push("@prefix owl: <http://www.w3.org/2002/07/owl#> .");
  lines.push("@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .");
  lines.push(`@prefix skos: <${SKOS_NS}> .`);
  lines.push("@prefix sssom: <https://w3id.org/sssom/> .");
  lines.push("@prefix semapv: <https://w3id.org/semapv/vocab/> .");
  lines.push("@prefix dralign: <http://www.w3id.org/ecsel-dr/alignment#> .");
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
      props.push(`   dralign:lexicalSimilarity ${dbl(e.facets.lexical)}`);
      if (e.facets.structural !== undefined)
        props.push(`   dralign:structuralSimilarity ${dbl(e.facets.structural)}`);
      if (e.facets.semantic !== undefined)
        props.push(`   dralign:semanticSimilarity ${dbl(e.facets.semantic)}`);
    }
    if (e.importance !== undefined)
      props.push(`   dralign:importanceScore ${dbl(e.importance)}`);
    lines.push(props.join(" ;\n") + " .");
  }
  return lines.join("\n");
}

/** Export SSSOM TSV (format d'échange standard des mappings). */
function sssomTsv(id: string, name: string, linked: MappingEntry[]): string {
  const esc = (s: string) => s.replace(/[\t\n\r]+/g, " ").trim();
  const lines: string[] = [
    "# curie_map:",
    `#   skos: ${SKOS_NS}`,
    "#   semapv: https://w3id.org/semapv/vocab/",
    `# mapping_set_id: urn:uuid:${id}`,
    `# mapping_set_description: Alignment of "${esc(name).replace(/"/g, "'")}" onto the Digital Reference`,
    "# mapping_tool: Digital Reference Explorer",
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

export function sssomFilePath(id: string): string | null {
  if (!VALID_ID.test(id)) return null;
  const p = join(WS_DIR, `${id}-mappings.sssom.tsv`);
  return existsSync(p) ? p : null;
}

export async function mapToDr(id: string): Promise<MappingReport> {
  const { classes, content, name, ext, store } = loadImported(id);
  const { perClass, truncated } = await bestDrMatches(classes, id);
  const drCardByIri = new Map((await drIndex()).cards.map((c) => [c.iri, c]));

  /* Importance : centralité (degré normalisé) dans l'ontologie importée.
     Sert à vérifier les concepts centraux en premier (un échec API en
     cours de route sacrifie d'abord les classes périphériques). */
  const maxDegree = classes.reduce((m, c) => Math.max(m, c.degree), 1);
  const importanceOf = (wc: WsClass) => r3(wc.degree / maxDegree);

  // Vérification LLM uniquement pour les candidats plausibles : score
  // agrégé correct OU signal sémantique seul déjà fort (le structurel
  // peut plomber l'agrégé d'un vrai match sous un autre nom).
  const toVerify: { wc: WsClass; cands: MatchCandidate[] }[] = [];
  const entries: MappingEntry[] = [];
  perClass.forEach((cands, k) => {
    const best = cands[0];
    if (
      best &&
      (best.score >= 0.5 || (best.facets.detail.contextual ?? 0) >= 0.55)
    ) {
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
        ...(await verifyBatch(batch, drCardByIri)).map((e) => ({
          ...e,
          importance: importanceByIri.get(e.sourceIri),
        }))
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

  /* --- Nouvelle ontologie : copie de l'importée + axiomes vers le DR --- */
  const linked = entries.filter((e) => e.relation !== "none");
  const mapped =
    turtleBase(content, ext, store).trimEnd() +
    "\n" +
    alignmentTurtle(name, entries, linked) +
    "\n";
  loadStore(mapped, "ttl"); // validation : le résultat doit se parser
  writeFileSync(join(WS_DIR, `${id}-mapped.ttl`), mapped, "utf8");
  writeFileSync(join(WS_DIR, `${id}-mappings.sssom.tsv`), sssomTsv(id, name, linked), "utf8");
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
