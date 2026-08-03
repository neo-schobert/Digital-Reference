import oxigraph from "oxigraph";

/* ------------------------------------------------------------------ */
/* Primitives RDF partagées : chargement d'un fichier quel que soit son */
/* format, extraction des classes, des préfixes et des namespaces.     */
/* Aucun de ces helpers ne connaît le Digital Reference : ils servent   */
/* aussi bien à la référence d'un projet qu'à une ontologie importée.   */
/* ------------------------------------------------------------------ */

export type Store = InstanceType<typeof oxigraph.Store>;

export const FORMAT_BY_EXT: Record<string, string> = {
  ttl: "text/turtle",
  n3: "text/turtle",
  nt: "application/n-triples",
  rdf: "application/rdf+xml",
  owl: "application/rdf+xml",
  xml: "application/rdf+xml",
};

export const DEFAULT_BASE = "http://example.org/imported#";

export function extOf(filename: string): string {
  return (filename.split(".").pop() ?? "ttl").toLowerCase();
}

export function localName(iri: string): string {
  const idx = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/"));
  return idx >= 0 ? iri.slice(idx + 1) : iri;
}

export function namespaceOf(iri: string): string {
  const idx = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/"));
  return idx >= 0 ? iri.slice(0, idx + 1) : iri;
}

/** Charge du contenu RDF dans un store existant (signature moderne ou
    positionnelle selon la version d'oxigraph installée). */
export function loadInto(
  store: Store,
  content: string,
  ext: string,
  base = DEFAULT_BASE
): void {
  const format = FORMAT_BY_EXT[ext] ?? "text/turtle";
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
}

export function loadStore(content: string, ext: string, base = DEFAULT_BASE): Store {
  const store = new oxigraph.Store();
  loadInto(store, content, ext, base);
  return store;
}

export function dumpTurtle(store: Store): string {
  try {
    return store.dump({ format: "text/turtle" }) as string;
  } catch {
    return (store.dump as unknown as (f: string) => string)("text/turtle");
  }
}

/* ------------------------- Requêtes typées -------------------------- */

export type Term = {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
};
export type Binding = Map<string, Term>;

const COMMON_PREFIXES = `PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX dc: <http://purl.org/dc/elements/1.1/>
`;

export function select(store: Store, sparql: string): Binding[] {
  return store.query(COMMON_PREFIXES + sparql) as Binding[];
}

/* ---------------------- Classes d'une ontologie --------------------- */

export interface OntoClass {
  iri: string;
  label: string;
  comment?: string;
  supers: string[];
  /** labels alternatifs (skos:altLabel / prefLabel) — métrique synonymes */
  alts: string[];
  /** labels des voisins directs (hiérarchie + propriétés objet) */
  neighbors: string[];
  /** degré dans l'ontologie (centralité → score d'importance) */
  degree: number;
  text: string; // fiche verbalisée (embedding + prompts)
}

/**
 * Classes OWL/RDFS d'un store, avec le contexte utilisé par les matchers
 * (parents, voisins, synonymes) et la fiche verbalisée.
 */
export function parseClasses(store: Store): {
  classes: OntoClass[];
  propertyCount: number;
} {
  const byIri = new Map<string, OntoClass>();
  for (const b of select(
    store,
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
      c = {
        iri,
        label: localName(iri),
        supers: [],
        alts: [],
        neighbors: [],
        degree: 0,
        text: "",
      };
      byIri.set(iri, c);
    }
    const label = b.get("label");
    if (label && (c.label === localName(iri) || label.language === "en"))
      c.label = label.value;
    const comment = b.get("comment");
    if (comment && (!c.comment || comment.language === "en"))
      c.comment = comment.value;
  }
  for (const b of select(
    store,
    `SELECT ?c ?alt WHERE {
       { ?c skos:altLabel ?alt } UNION { ?c skos:prefLabel ?alt }
     }`
  )) {
    const c = byIri.get(b.get("c")!.value);
    const alt = b.get("alt")?.value;
    if (c && alt && alt !== c.label && c.alts.length < 8 && !c.alts.includes(alt))
      c.alts.push(alt);
  }
  const addNeighbor = (c: OntoClass, label: string) => {
    c.degree++;
    if (c.neighbors.length < 24 && !c.neighbors.includes(label))
      c.neighbors.push(label);
  };
  for (const b of select(
    store,
    `SELECT ?s ?o WHERE { ?s rdfs:subClassOf ?o . FILTER(isIRI(?s) && isIRI(?o)) }`
  )) {
    const c = byIri.get(b.get("s")!.value);
    const o = byIri.get(b.get("o")!.value);
    if (!c || !o) continue;
    if (c.supers.length < 6) c.supers.push(o.label);
    addNeighbor(c, o.label);
    addNeighbor(o, c.label);
  }
  for (const b of select(
    store,
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
  for (const _ of select(
    store,
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

/* --------------------- Identité d'une ontologie --------------------- */

export interface OntologyIdentity {
  /** IRI déclarée `a owl:Ontology` (la plus « peuplée » si plusieurs) */
  ontologyIri?: string;
  /** titre déclaré (rdfs:label / dcterms:title) */
  title?: string;
  description?: string;
  version?: string;
  /** namespaces que cette ontologie définit elle-même, du plus au moins peuplé */
  namespaces: string[];
}

/**
 * Ce que l'ontologie dit d'elle-même + les namespaces qu'elle définit
 * (histogramme des sujets IRI). Sert à distinguer, dans la référence d'un
 * projet, ce qui vient d'elle de ce qui vient de ses dépendances.
 */
export function ontologyIdentity(store: Store): OntologyIdentity {
  const counts = new Map<string, number>();
  for (const b of select(
    store,
    `SELECT ?s WHERE { ?s ?p ?o . FILTER(isIRI(?s)) }`
  )) {
    const ns = namespaceOf(b.get("s")!.value);
    counts.set(ns, (counts.get(ns) ?? 0) + 1);
  }
  const namespaces = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, n]) => n >= 3)
    .slice(0, 64)
    .map(([ns]) => ns);

  const declared = select(
    store,
    `SELECT ?o ?label ?title ?comment ?description ?version WHERE {
       ?o a owl:Ontology . FILTER(isIRI(?o))
       OPTIONAL { ?o rdfs:label ?label }
       OPTIONAL { ?o dcterms:title ?title }
       OPTIONAL { ?o rdfs:comment ?comment }
       OPTIONAL { ?o dcterms:description ?description }
       OPTIONAL { ?o owl:versionInfo ?version }
     }`
  );
  // Plusieurs owl:Ontology possibles (fichier fusionné) : garder celle dont
  // le namespace est le plus représenté dans les sujets.
  let best: Binding | undefined;
  let bestRank = Infinity;
  for (const b of declared) {
    const iri = b.get("o")!.value;
    const rank = namespaces.indexOf(namespaceOf(iri + "#"));
    const rank2 = namespaces.indexOf(namespaceOf(iri.endsWith("/") ? iri : iri + "/"));
    const r = Math.min(rank < 0 ? 99 : rank, rank2 < 0 ? 99 : rank2);
    if (r < bestRank) {
      bestRank = r;
      best = b;
    }
  }
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = best?.get(k)?.value;
      if (v) return v;
    }
    return undefined;
  };
  return {
    ontologyIri: best?.get("o")?.value,
    title: pick("label", "title"),
    description: pick("description", "comment"),
    version: pick("version"),
    namespaces,
  };
}

/* --------------------------- Préfixes ------------------------------- */

/** Préfixes toujours disponibles, quelle que soit l'ontologie chargée. */
export const WELL_KNOWN_PREFIXES: Record<string, string> = {
  owl: "http://www.w3.org/2002/07/owl#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  dc: "http://purl.org/dc/elements/1.1/",
  terms: "http://purl.org/dc/terms/",
  foaf: "http://xmlns.com/foaf/0.1/",
  schema: "http://schema.org/",
  org: "http://www.w3.org/ns/org#",
  sssom: "https://w3id.org/sssom/",
};

/** Vocabulaires tiers reconnus : toujours « externes » dans un graphe. */
export const WELL_KNOWN_VOCABULARIES: [string, string][] = [
  ["http://www.w3.org/ns/ssn/systems/", "SSN-System"],
  ["http://www.w3.org/ns/ssn/ext/", "SSN-Ext"],
  ["http://www.w3.org/ns/ssn/", "SSN"],
  ["http://www.w3.org/ns/sosa/", "SOSA"],
  ["http://www.w3.org/2006/time#", "Time"],
  ["http://schema.org/", "Schema.org"],
  ["http://www.w3.org/ns/org#", "W3C-Org"],
  ["http://xmlns.com/foaf/0.1/", "FOAF"],
  ["http://www.w3.org/2004/02/skos/core#", "SKOS"],
  ["http://purl.org/dc/terms/", "DC-Terms"],
  ["http://www.w3.org/2002/07/owl#", "OWL"],
  ["http://www.w3.org/2000/01/rdf-schema#", "RDFS"],
];

/** Déclarations `@prefix p: <ns> .` / `PREFIX p: <ns>` d'un source RDF. */
export function extractPrefixes(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(?:^|\n)\s*(?:@prefix|PREFIX|@PREFIX|prefix)\s+([A-Za-z][\w.-]*)?\s*:\s*<([^>]+)>/g;
  for (const m of content.matchAll(re)) {
    const name = m[1];
    if (!name) continue; // préfixe vide `: <…>` : pas de nom utilisable
    // Les IRIs relatives (`<../../2006/time#>`) dépendent d'une base qu'on ne
    // connaît pas à coup sûr : les garder produirait un en-tête SPARQL
    // invalide, on ne retient donc que les IRIs absolues.
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(m[2])) continue;
    if (!(name in out)) out[name] = m[2];
  }
  return out;
}
