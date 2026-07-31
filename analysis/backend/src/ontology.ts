import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import oxigraph from "oxigraph";

/* ------------------------------------------------------------------ */
/* Types partagés avec le frontend (dupliqués côté front)              */
/* ------------------------------------------------------------------ */

export interface GraphNode {
  id: string; // IRI
  label: string;
  module: string;
  /** Lobes du Digital Reference auxquels la classe se rattache (via subClassOf*) */
  lobes: string[];
  comment?: string;
  external: boolean;
  degree: number;
  attributes: { iri: string; label: string; range?: string }[];
}

export interface LobeInfo {
  id: string; // local name, ex. "Supply_Chain_Lobe"
  iri: string;
  label: string;
  comment?: string;
  classCount: number;
}

export interface GraphLink {
  source: string;
  target: string;
  type: "subclass" | "property";
  label?: string;
  iri?: string;
}

export interface ModuleInfo {
  id: string;
  namespace: string;
  classCount: number;
  external: boolean;
}

export interface Meta {
  ontology: {
    title: string;
    description: string;
    version: string;
    modified: string;
    triples: number;
  };
  counts: { classes: number; objectProperties: number; datatypeProperties: number };
  modules: ModuleInfo[];
  lobes: LobeInfo[];
  prefixes: Record<string, string>;
  files: { name: string; path: string; size: number }[];
}

/* ------------------------------------------------------------------ */
/* Localisation des fichiers                                           */
/* ------------------------------------------------------------------ */

const DR_ROOT = resolve(process.env.DR_ROOT ?? join(import.meta.dirname, "..", "..", ".."));
const MAIN_TTL = join(DR_ROOT, "DigitalReference.ttl");
const DEPS_DIR = join(DR_ROOT, "dependencies");

export function listFiles(): { name: string; path: string; size: number }[] {
  const files: { name: string; path: string; size: number }[] = [];
  const push = (name: string, path: string) => {
    const size = readFileSync(path).byteLength;
    files.push({ name, path, size });
  };
  push("DigitalReference.ttl", MAIN_TTL);
  if (existsSync(DEPS_DIR)) {
    for (const f of readdirSync(DEPS_DIR).filter((f) => f.endsWith(".ttl")).sort()) {
      push(`dependencies/${f}`, join(DEPS_DIR, f));
    }
  }
  return files;
}

export function filePathFor(name: string): string | null {
  const found = listFiles().find((f) => f.name === name);
  return found ? found.path : null;
}

/* ------------------------------------------------------------------ */
/* Préfixes / modules                                                  */
/* ------------------------------------------------------------------ */

export const PREFIXES: Record<string, string> = {
  dr: "http://www.w3id.org/ecsel-dr#",
  "ecsel-dr-AT": "http://www.w3id.org/ecsel-dr-AT#",
  "ecsel-dr-DF": "http://www.w3id.org/ecsel-dr-DF#",
  "ecsel-dr-OM": "http://www.w3id.org/ecsel-dr-OM#",
  "ecsel-dr-SO": "http://www.w3id.org/ecsel-dr-SO#",
  "ecsel-dr-BMS": "http://www.w3id.org/ecsel-dr-BMS#",
  "ecsel-dr-GDM": "http://www.w3id.org/ecsel-dr-GDM#",
  "ecsel-dr-PMV": "http://www.w3id.org/ecsel-dr-PMV#",
  "ecsel-dr-PROD": "http://www.w3id.org/ecsel-dr-PROD#",
  "ecsel-dr-OOSMP": "http://www.w3id.org/ecsel-dr-OOSMP#",
  "ecsel-dr-RAMI40": "http://www.w3id.org/ecsel-dr-RAMI40#",
  "ecsel-dr-Planning": "http://www.w3id.org/ecsel-dr-Planning#",
  "ecsel-dr-Incoterms": "http://www.w3id.org/ecsel-dr-Incoterms#",
  "ecsel-dr-CO2Savings": "http://www.w3id.org/ecsel-dr-CO2Savings#",
  "ecsel-dr-Cloud-AH": "http://www.w3id.org/ecsel-dr-Cloud-AH#",
  "ecsel-dr-Power-PWR": "http://www.w3id.org/ecsel-dr-Power-PWR#",
  "ecsel-dr-Planning-SCP": "http://www.w3id.org/ecsel-dr-Planning-SCP#",
  "ecsel-dr-Planning-DF": "http://www.w3id.org/ecsel-dr-Planning-DF#",
  "ecsel-dr-Organization": "http://www.w3id.org/ecsel-dr-Organization#",
  "ecsel-dr-Organization-ORG": "http://www.w3id.org/ecsel-dr-Organization-ORG#",
  "ecsel-dr-PWR": "http://www.w3id.org/ecsel-dr-PWR#",
  owl: "http://www.w3.org/2002/07/owl#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  foaf: "http://xmlns.com/foaf/0.1/",
  dc: "http://purl.org/dc/elements/1.1/",
  terms: "http://purl.org/dc/terms/",
  schema: "http://schema.org/",
  org: "http://www.w3.org/ns/org#",
  sosa: "http://www.w3.org/ns/sosa/",
  ssn: "http://www.w3.org/ns/ssn/",
  "ssn-system": "http://www.w3.org/ns/ssn/systems/",
  "ssn-ext": "http://www.w3.org/ns/ssn/ext/",
  time: "http://www.w3.org/2006/time#",
};

const EXTERNAL_MODULES: [string, string][] = [
  ["http://www.w3.org/ns/ssn/systems/", "SSN-System"],
  ["http://www.w3.org/ns/ssn/ext/", "SSN-Ext"],
  ["http://www.w3.org/ns/ssn/", "SSN"],
  ["http://www.w3.org/ns/sosa/", "SOSA"],
  ["http://www.w3.org/2006/time#", "Time"],
  ["http://schema.org/", "Schema.org"],
  ["http://www.w3.org/ns/org#", "W3C-Org"],
  ["http://xmlns.com/foaf/0.1/", "FOAF"],
  ["http://www.w3.org/2004/02/skos/core#", "SKOS"],
];

const INTERNAL_RE = /^http:\/\/www\.w3id\.org\/ecsel-dr(?:-([A-Za-z0-9-]+))?#/;

export function moduleOf(iri: string): { module: string; external: boolean } {
  const m = iri.match(INTERNAL_RE);
  if (m) return { module: m[1] ?? "Core", external: false };
  for (const [ns, name] of EXTERNAL_MODULES) {
    if (iri.startsWith(ns)) return { module: name, external: true };
  }
  return { module: "Autres", external: true };
}

function localName(iri: string): string {
  const idx = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/"));
  return idx >= 0 ? iri.slice(idx + 1) : iri;
}

/* ------------------------------------------------------------------ */
/* Store oxigraph                                                      */
/* ------------------------------------------------------------------ */

export const store = new oxigraph.Store();

function loadTtl(path: string) {
  const data = readFileSync(path, "utf8");
  try {
    store.load(data, { format: "text/turtle", base_iri: "http://www.w3id.org/ecsel-dr#" });
  } catch (e) {
    // Signature positionnelle des anciennes versions d'oxigraph
    (store.load as unknown as (d: string, f: string, b: string) => void)(
      data,
      "text/turtle",
      "http://www.w3id.org/ecsel-dr#"
    );
  }
}

const SPARQL_PREFIX_HEADER = Object.entries(PREFIXES)
  .map(([p, ns]) => `PREFIX ${p}: <${ns}>`)
  .join("\n");

type Term = { termType: string; value: string; language?: string; datatype?: { value: string } };
type Binding = Map<string, Term>;

function q(sparql: string): Binding[] {
  return store.query(SPARQL_PREFIX_HEADER + "\n" + sparql) as Binding[];
}

/* ------------------------------------------------------------------ */
/* Construction du graphe (une fois au démarrage)                      */
/* ------------------------------------------------------------------ */

export interface BuiltGraph {
  nodes: GraphNode[];
  links: GraphLink[];
}

let fullGraph: BuiltGraph = { nodes: [], links: [] };
let meta: Meta | null = null;

function preferEnglish(current: string | undefined, term: Term | undefined): string | undefined {
  if (!term) return current;
  if (current === undefined) return term.value;
  if (term.language === "en") return term.value;
  return current;
}

export function buildGraph(): void {
  const t0 = Date.now();
  loadTtl(MAIN_TTL);
  if (existsSync(DEPS_DIR)) {
    for (const f of readdirSync(DEPS_DIR).filter((f) => f.endsWith(".ttl")).sort()) {
      loadTtl(join(DEPS_DIR, f));
    }
  }

  // --- Classes -----------------------------------------------------
  const nodes = new Map<string, GraphNode>();
  for (const b of q(
    `SELECT ?c ?label ?comment WHERE {
       ?c a owl:Class . FILTER(isIRI(?c))
       OPTIONAL { ?c rdfs:label ?label }
       OPTIONAL { ?c rdfs:comment ?comment }
     }`
  )) {
    const iri = b.get("c")!.value;
    const { module, external } = moduleOf(iri);
    let node = nodes.get(iri);
    if (!node) {
      node = {
        id: iri,
        label: localName(iri),
        module,
        lobes: [],
        external,
        degree: 0,
        attributes: [],
      };
      nodes.set(iri, node);
    }
    const label = preferEnglish(
      node.label === localName(iri) ? undefined : node.label,
      b.get("label")
    );
    if (label) node.label = label;
    node.comment = preferEnglish(node.comment, b.get("comment"));
  }

  // --- Hiérarchie subClassOf ---------------------------------------
  const links: GraphLink[] = [];
  const seenLinks = new Set<string>();
  for (const b of q(
    `SELECT ?s ?o WHERE { ?s rdfs:subClassOf ?o . FILTER(isIRI(?s) && isIRI(?o)) }`
  )) {
    const s = b.get("s")!.value;
    const o = b.get("o")!.value;
    if (!nodes.has(s) || !nodes.has(o) || s === o) continue;
    const key = `sub|${s}|${o}`;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    links.push({ source: s, target: o, type: "subclass", label: "subClassOf" });
  }

  // --- Lobes : appartenance via la fermeture subClassOf* ------------
  const childrenOf = new Map<string, string[]>();
  for (const l of links) {
    if (!childrenOf.has(l.target)) childrenOf.set(l.target, []);
    childrenOf.get(l.target)!.push(l.source);
  }
  const lobeInfos: LobeInfo[] = [];
  for (const root of [...nodes.values()].filter(
    (n) => n.module === "Core" && n.id.endsWith("_Lobe")
  )) {
    const lobeId = localName(root.id);
    const members = new Set<string>([root.id]);
    const stack = [root.id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const child of childrenOf.get(cur) ?? []) {
        if (!members.has(child)) {
          members.add(child);
          stack.push(child);
        }
      }
    }
    for (const iri of members) {
      const n = nodes.get(iri);
      if (n && !n.lobes.includes(lobeId)) n.lobes.push(lobeId);
    }
    lobeInfos.push({
      id: lobeId,
      iri: root.id,
      label: root.label.replace(/[ _]Lobe$/, ""),
      comment: root.comment,
      classCount: members.size,
    });
  }
  lobeInfos.sort((a, b) => b.classCount - a.classCount);

  // --- Object properties : domain/range (avec owl:unionOf) ---------
  const propLabels = new Map<string, string>();
  for (const b of q(
    `SELECT DISTINCT ?p ?label WHERE {
       ?p a owl:ObjectProperty . FILTER(isIRI(?p))
       OPTIONAL { ?p rdfs:label ?label }
     }`
  )) {
    const iri = b.get("p")!.value;
    const label = preferEnglish(propLabels.get(iri), b.get("label"));
    propLabels.set(iri, label ?? localName(iri));
  }

  const collect = (predicate: string): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const b of q(
      `SELECT DISTINCT ?p ?x WHERE {
         ?p a owl:ObjectProperty .
         { ?p ${predicate} ?x . FILTER(isIRI(?x)) }
         UNION
         { ?p ${predicate}/owl:unionOf/rdf:rest*/rdf:first ?x . FILTER(isIRI(?x)) }
       }`
    )) {
      const p = b.get("p")!.value;
      const x = b.get("x")!.value;
      if (!out.has(p)) out.set(p, []);
      out.get(p)!.push(x);
    }
    return out;
  };
  const domains = collect("rdfs:domain");
  const ranges = collect("rdfs:range");

  for (const [p, label] of propLabels) {
    const ds = (domains.get(p) ?? []).filter((d) => nodes.has(d)).slice(0, 6);
    const rs = (ranges.get(p) ?? []).filter((r) => nodes.has(r)).slice(0, 6);
    for (const d of ds) {
      for (const r of rs) {
        const key = `prop|${d}|${r}|${p}`;
        if (seenLinks.has(key)) continue;
        seenLinks.add(key);
        links.push({ source: d, target: r, type: "property", label, iri: p });
      }
    }
  }

  // --- Datatype properties → attributs des classes ------------------
  let datatypePropCount = 0;
  const seenDt = new Set<string>();
  for (const b of q(
    `SELECT DISTINCT ?p ?label ?d ?r WHERE {
       ?p a owl:DatatypeProperty . FILTER(isIRI(?p))
       OPTIONAL { ?p rdfs:label ?label }
       OPTIONAL { ?p rdfs:range ?r . FILTER(isIRI(?r)) }
       { ?p rdfs:domain ?d . FILTER(isIRI(?d)) }
       UNION
       { ?p rdfs:domain/owl:unionOf/rdf:rest*/rdf:first ?d . FILTER(isIRI(?d)) }
     }`
  )) {
    const p = b.get("p")!.value;
    if (!seenDt.has(p)) {
      seenDt.add(p);
      datatypePropCount++;
    }
    const d = b.get("d")!.value;
    const node = nodes.get(d);
    if (!node) continue;
    if (node.attributes.some((a) => a.iri === p)) continue;
    node.attributes.push({
      iri: p,
      label: b.get("label")?.value ?? localName(p),
      range: b.get("r") ? localName(b.get("r")!.value) : undefined,
    });
  }

  // --- Degrés ------------------------------------------------------
  for (const l of links) {
    nodes.get(l.source)!.degree++;
    nodes.get(l.target)!.degree++;
  }

  fullGraph = { nodes: [...nodes.values()], links };

  // --- Meta --------------------------------------------------------
  const moduleMap = new Map<string, ModuleInfo>();
  for (const n of fullGraph.nodes) {
    let m = moduleMap.get(n.module);
    if (!m) {
      const nsEntry =
        n.module === "Core"
          ? PREFIXES["dr"]
          : PREFIXES[`ecsel-dr-${n.module}`] ??
            EXTERNAL_MODULES.find(([, name]) => name === n.module)?.[0] ??
            "";
      m = { id: n.module, namespace: nsEntry, classCount: 0, external: n.external };
      moduleMap.set(n.module, m);
    }
    m.classCount++;
  }
  const modules = [...moduleMap.values()].sort((a, b) => {
    if (a.external !== b.external) return a.external ? 1 : -1;
    return b.classCount - a.classCount;
  });

  const ontoInfo: Record<string, string> = {};
  for (const b of q(
    `SELECT ?p ?o WHERE { <http://www.w3id.org/ecsel-dr> ?p ?o . FILTER(isLiteral(?o)) }`
  )) {
    ontoInfo[localName(b.get("p")!.value)] = b.get("o")!.value;
  }

  meta = {
    ontology: {
      title: ontoInfo["label"] ?? "Digital Reference",
      description: ontoInfo["description"] ?? "",
      version: ontoInfo["versionInfo"] ?? "",
      modified: ontoInfo["modified"] ?? "",
      triples: store.size,
    },
    counts: {
      classes: fullGraph.nodes.length,
      objectProperties: propLabels.size,
      datatypeProperties: datatypePropCount,
    },
    modules,
    lobes: lobeInfos,
    prefixes: PREFIXES,
    files: listFiles(),
  };

  console.log(
    `[ontology] ${store.size} triplets, ${fullGraph.nodes.length} classes, ` +
      `${links.length} arêtes, ${modules.length} modules, ${lobeInfos.length} lobes — construit en ${Date.now() - t0} ms`
  );
}

export function getFullGraph(): BuiltGraph {
  return fullGraph;
}

export function getMeta(): Meta {
  if (!meta) throw new Error("Ontology not loaded");
  return meta;
}

export function getGraph(opts: {
  modules?: Set<string>;
  lobes?: Set<string>;
  edges?: Set<string>;
}): BuiltGraph {
  const { modules, lobes, edges } = opts;
  let nodes = fullGraph.nodes;
  if (modules) nodes = nodes.filter((n) => modules.has(n.module));
  if (lobes) {
    nodes = nodes.filter(
      (n) =>
        n.lobes.some((l) => lobes.has(l)) ||
        (lobes.has("none") && n.lobes.length === 0)
    );
  }
  const kept = new Set(nodes.map((n) => n.id));
  const links = fullGraph.links.filter(
    (l) =>
      kept.has(l.source) &&
      kept.has(l.target) &&
      (!edges || edges.has(l.type))
  );
  return { nodes, links };
}

/* ------------------------------------------------------------------ */
/* SPARQL utilisateur                                                  */
/* ------------------------------------------------------------------ */

function termToJson(t: Term): Record<string, string> {
  if (t.termType === "NamedNode") return { type: "uri", value: t.value };
  if (t.termType === "BlankNode") return { type: "bnode", value: t.value };
  const out: Record<string, string> = { type: "literal", value: t.value };
  if (t.language) out["xml:lang"] = t.language;
  else if (t.datatype && t.datatype.value !== "http://www.w3.org/2001/XMLSchema#string")
    out.datatype = t.datatype.value;
  return out;
}

export function runSparql(query: string): unknown {
  const result = store.query(query);

  if (typeof result === "boolean") {
    return { type: "boolean", boolean: result };
  }

  if (Array.isArray(result) && (result.length === 0 || result[0] instanceof Map)) {
    // SELECT
    const bindings = (result as Binding[]).map((b) => {
      const row: Record<string, Record<string, string>> = {};
      for (const [k, v] of b.entries()) row[k] = termToJson(v as Term);
      return row;
    });
    const varsFromQuery =
      [...query.matchAll(/\?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    const vars =
      bindings.length > 0
        ? [...new Set(bindings.flatMap((b) => Object.keys(b)))]
        : [...new Set(varsFromQuery)];
    return { type: "bindings", head: { vars }, results: { bindings } };
  }

  // CONSTRUCT / DESCRIBE → tableau de quads
  const quads = result as { subject: Term; predicate: Term; object: Term }[];
  const triples = quads.map((t) => ({
    s: termToJson(t.subject),
    p: termToJson(t.predicate),
    o: termToJson(t.object),
  }));
  let turtle = "";
  try {
    const tmp = new oxigraph.Store(quads as never[]);
    turtle = tmp.dump({ format: "text/turtle" });
  } catch {
    try {
      const tmp = new oxigraph.Store(quads as never[]);
      turtle = (tmp.dump as unknown as (f: string) => string)("text/turtle");
    } catch {
      turtle = "";
    }
  }
  return { type: "graph", triples, turtle };
}

/* ------------------------------------------------------------------ */
/* Stub chatbot : recherche lexicale en attendant le GraphRAG          */
/* ------------------------------------------------------------------ */

export function chatStub(message: string): string {
  const words = message
    .toLowerCase()
    .split(/[^a-zà-ÿ0-9]+/i)
    .filter((w) => w.length >= 4);

  const matches: { node: GraphNode; score: number }[] = [];
  if (words.length > 0) {
    for (const n of fullGraph.nodes) {
      const hay = `${n.label} ${n.comment ?? ""}`.toLowerCase();
      const score = words.reduce((acc, w) => acc + (hay.includes(w) ? 1 : 0), 0);
      if (score > 0) matches.push({ node: n, score });
    }
    matches.sort((a, b) => b.score - a.score || b.node.degree - a.node.degree);
  }

  const lines: string[] = [];
  lines.push(
    "**⚠️ Demo mode** — the GraphRAG engine is not wired up yet. " +
      "This answer was generated by a simple lexical search over the ontology."
  );
  if (matches.length > 0) {
    lines.push("");
    lines.push(`Here are the Digital Reference concepts that seem related to your question:`);
    for (const { node } of matches.slice(0, 6)) {
      const desc = node.comment
        ? ` — ${node.comment.slice(0, 180)}${node.comment.length > 180 ? "…" : ""}`
        : "";
      lines.push(`- **${node.label}** _(module ${node.module})_${desc}`);
    }
    lines.push("");
    lines.push(
      "You can explore these concepts in the **Graph** tab."
    );
  } else {
    lines.push("");
    lines.push(
      "I could not find any matching concept in the ontology. " +
        "Once the GraphRAG engine is connected, I will be able to answer more open questions about the Digital Reference " +
        "(structure, modules, relations between concepts…)."
    );
  }
  return lines.join("\n");
}
