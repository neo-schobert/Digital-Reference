import { readFileSync } from "node:fs";
import oxigraph from "oxigraph";
import {
  HttpError,
  OntologyFile,
  onProjectInvalidated,
  referenceFiles,
  requireProject,
} from "./projects.js";
import {
  Term,
  WELL_KNOWN_PREFIXES,
  WELL_KNOWN_VOCABULARIES,
  extOf,
  loadInto,
  localName,
  namespaceOf,
  select,
  type Store,
} from "./rdf.js";

/* ------------------------------------------------------------------ */
/* Référence d'un projet                                               */
/*                                                                     */
/* L'ontologie de référence d'un projet est chargée avec la fermeture  */
/* de ses dépendances dans un store oxigraph, puis convertie en graphe */
/* de classes (mêmes structures qu'avant, mais plus rien n'est codé en */
/* dur pour le Digital Reference) :                                    */
/*  - modules : déduits des namespaces que la référence définit        */
/*    elle-même (internes) vs ceux de ses dépendances (externes) ;     */
/*  - groupes de haut niveau (« lobes ») : classes `*_Lobe` si         */
/*    l'ontologie suit cette convention, sinon les racines de la       */
/*    hiérarchie ;                                                     */
/*  - préfixes : ceux déclarés dans les fichiers + les usuels.         */
/* ------------------------------------------------------------------ */

export interface GraphNode {
  id: string; // IRI
  label: string;
  module: string;
  /** Groupes de haut niveau auxquels la classe se rattache (via subClassOf*) */
  lobes: string[];
  comment?: string;
  external: boolean;
  degree: number;
  attributes: { iri: string; label: string; range?: string }[];
}

export interface GraphLink {
  source: string;
  target: string;
  type: "subclass" | "property";
  label?: string;
  iri?: string;
}

export interface BuiltGraph {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface LobeInfo {
  id: string; // nom local, ex. "Supply_Chain_Lobe"
  iri: string;
  label: string;
  comment?: string;
  classCount: number;
}

export interface ModuleInfo {
  id: string;
  namespace: string;
  classCount: number;
  external: boolean;
}

export interface MetaFile {
  ontologyId: string;
  name: string;
  size: number;
  role: "reference" | "dependency";
}

export interface Meta {
  project: { id: string; name: string };
  reference: { ontologyId: string; name: string };
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
  /** Libellé du regroupement de haut niveau : « Lobes » ou « Groups » */
  groupLabel: string;
  prefixes: Record<string, string>;
  files: MetaFile[];
}

export interface BuiltReference {
  projectId: string;
  store: Store;
  graph: BuiltGraph;
  meta: Meta;
  prefixes: Record<string, string>;
  /** en-tête `PREFIX …` prêt à préfixer une requête SPARQL */
  prefixHeader: string;
  files: OntologyFile[];
  /** IRI → forme préfixée (`dr:Wafer`) quand un préfixe correspond */
  shrink: (iri: string) => string;
  /** Module d'un IRI quelconque (y compris les propriétés, hors graphe) */
  moduleOf: (iri: string) => { module: string; external: boolean };
}

/* --------------------------- Construction --------------------------- */

function preferEnglish(current: string | undefined, term: Term | undefined): string | undefined {
  if (!term) return current;
  if (current === undefined) return term.value;
  if (term.language === "en") return term.value;
  return current;
}

/** Nom court lisible pour un namespace, à partir des préfixes déclarés. */
function nameForNamespace(ns: string, prefixes: Record<string, string>): string {
  for (const [p, value] of Object.entries(prefixes)) {
    if (value === ns) return p;
  }
  const trimmed = ns.replace(/[#/]$/, "");
  const seg = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":")) + 1);
  return seg || ns;
}

/**
 * Racine commune des noms de modules internes (`ecsel-dr-AT` → `AT`).
 * On retient la plus longue racine partagée par la MAJORITÉ des noms : un
 * ou deux namespaces exotiques ne doivent pas empêcher le raccourcissement.
 */
function stripCommonStem(names: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const n of names) {
    for (let i = 1; i < n.length; i++) {
      if ("-_.".includes(n[i])) {
        const stem = n.slice(0, i + 1);
        counts.set(stem, (counts.get(stem) ?? 0) + 1);
      }
    }
  }
  const threshold = Math.max(2, Math.ceil(names.length / 2));
  let stem = "";
  for (const [s, c] of counts) {
    if (c >= threshold && s.length > stem.length) stem = s;
  }
  const out = new Map<string, string>();
  for (const n of names) {
    const short = stem && n.startsWith(stem) ? n.slice(stem.length) : n;
    out.set(n, short || n);
  }
  return out;
}

interface Classifier {
  moduleOf: (iri: string) => { module: string; external: boolean };
  moduleNamespace: Map<string, string>;
}

/**
 * Classification des IRIs en modules : ce que la référence définit
 * elle-même est « interne » (un module par namespace), le reste vient des
 * dépendances ou de vocabulaires tiers connus.
 */
function buildClassifier(
  files: OntologyFile[],
  prefixes: Record<string, string>
): Classifier {
  const reference = files.find((f) => f.role === "reference");
  // Un namespace « interne » est défini par la référence elle-même : ni par
  // une de ses dépendances (SOSA reste SOSA même si la référence l'annote),
  // ni par un vocabulaire standard (owl, skos, dcterms…).
  const depNs = new Set<string>();
  for (const f of files) {
    if (f.role === "reference") continue;
    for (const ns of f.namespaces) depNs.add(ns);
  }
  const standardNs = new Set(Object.values(WELL_KNOWN_PREFIXES));
  const isStandard = (ns: string) =>
    standardNs.has(ns) || WELL_KNOWN_VOCABULARIES.some(([p]) => ns.startsWith(p));
  const baseCandidates = reference?.ontologyIri
    ? [`${reference.ontologyIri}#`, `${reference.ontologyIri}/`, reference.ontologyIri]
    : [];
  // Le namespace de la référence elle-même reste TOUJOURS interne, même
  // s'il s'agit d'un vocabulaire standard (un projet peut très bien prendre
  // SOSA ou SKOS comme référence).
  const ownNs = baseCandidates.filter((c) => (reference?.namespaces ?? []).includes(c));
  const internal = new Set([
    ...ownNs,
    ...(reference?.namespaces ?? []).filter(
      (ns) => !depNs.has(ns) && !isStandard(ns)
    ),
  ]);
  const baseNs = baseCandidates.find((c) => internal.has(c)) ?? [...internal][0] ?? "";

  const rawNames = new Map<string, string>();
  for (const ns of internal) {
    if (ns === baseNs) continue;
    rawNames.set(ns, nameForNamespace(ns, prefixes));
  }
  const shortened = stripCommonStem([...rawNames.values()]);
  const internalName = new Map<string, string>();
  if (baseNs) internalName.set(baseNs, "Core");
  for (const [ns, raw] of rawNames) internalName.set(ns, shortened.get(raw) ?? raw);

  const external = new Map<string, string>();
  for (const f of files) {
    if (f.role === "reference") continue;
    const short = f.name.replace(/\.[^.]+$/, "");
    for (const ns of f.namespaces) {
      if (internal.has(ns)) continue;
      if (!external.has(ns)) external.set(ns, nameForNamespace(ns, prefixes) || short);
    }
  }

  const moduleNamespace = new Map<string, string>();
  for (const [ns, name] of internalName) if (!moduleNamespace.has(name)) moduleNamespace.set(name, ns);
  for (const [ns, name] of external) if (!moduleNamespace.has(name)) moduleNamespace.set(name, ns);

  const cache = new Map<string, { module: string; external: boolean }>();
  const moduleOf = (iri: string) => {
    const hit = cache.get(iri);
    if (hit) return hit;
    const ns = namespaceOf(iri);
    let res: { module: string; external: boolean };
    if (internalName.has(ns)) {
      res = { module: internalName.get(ns)!, external: false };
    } else if (external.has(ns)) {
      res = { module: external.get(ns)!, external: true };
    } else {
      const known = WELL_KNOWN_VOCABULARIES.find(([prefix]) => iri.startsWith(prefix));
      if (known) {
        res = { module: known[1], external: true };
        if (!moduleNamespace.has(known[1])) moduleNamespace.set(known[1], known[0]);
      } else {
        res = { module: "Other", external: true };
      }
    }
    cache.set(iri, res);
    return res;
  };
  return { moduleOf, moduleNamespace };
}

function buildReference(projectId: string): BuiltReference {
  const project = requireProject(projectId);
  const files = referenceFiles(projectId);
  if (files.length === 0) {
    throw new HttpError(
      409,
      `The project "${project.name}" has no reference ontology yet — pick one in the Workspace tab.`
    );
  }
  const t0 = Date.now();
  const store = new oxigraph.Store();
  const reference = files.find((f) => f.role === "reference")!;
  const base = reference.ontologyIri ? `${reference.ontologyIri}#` : "http://example.org/reference#";
  // La référence d'abord, puis ses dépendances (l'ordre de chargement n'a
  // pas d'incidence sémantique — un store est un ensemble de triples — mais
  // il fixe l'ordre des résultats SPARQL, donc celui des fiches du chatbot).
  for (const f of files) {
    try {
      loadInto(store, readFileSync(f.path, "utf8"), extOf(f.path), base);
    } catch (e) {
      console.warn(`[reference] fichier ignoré (${f.name}): ${(e as Error).message}`);
    }
  }

  const prefixes: Record<string, string> = { ...WELL_KNOWN_PREFIXES };
  for (const f of files) {
    for (const [p, ns] of Object.entries(f.prefixes)) {
      if (!(p in prefixes)) prefixes[p] = ns;
    }
  }
  const { moduleOf, moduleNamespace } = buildClassifier(files, prefixes);
  const q = (sparql: string) => select(store, sparql);

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

  // --- Groupes de haut niveau (« lobes ») --------------------------
  const childrenOf = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const l of links) {
    if (l.type !== "subclass") continue;
    if (!childrenOf.has(l.target)) childrenOf.set(l.target, []);
    childrenOf.get(l.target)!.push(l.source);
    hasParent.add(l.source);
  }
  const descendantsOf = (root: string): Set<string> => {
    const members = new Set<string>([root]);
    const stack = [root];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const child of childrenOf.get(cur) ?? []) {
        if (!members.has(child)) {
          members.add(child);
          stack.push(child);
        }
      }
    }
    return members;
  };

  const allNodes = [...nodes.values()];
  // Convention `*_Lobe` (Digital Reference) si elle est suivie, sinon les
  // racines de la hiérarchie interne les plus peuplées.
  let roots = allNodes.filter((n) => !n.external && /_Lobe$/i.test(localName(n.id)));
  let groupLabel = "Lobes";
  if (roots.length < 2) {
    groupLabel = "Groups";
    roots = allNodes
      .filter((n) => !n.external && !hasParent.has(n.id) && (childrenOf.get(n.id)?.length ?? 0) > 0)
      .map((n) => ({ node: n, size: descendantsOf(n.id).size }))
      .filter((x) => x.size >= 3)
      .sort((a, b) => b.size - a.size)
      .slice(0, 20)
      .map((x) => x.node);
  }
  const lobeInfos: LobeInfo[] = [];
  for (const root of roots) {
    const lobeId = localName(root.id);
    const members = descendantsOf(root.id);
    for (const iri of members) {
      const n = nodes.get(iri);
      if (n && !n.lobes.includes(lobeId)) n.lobes.push(lobeId);
    }
    lobeInfos.push({
      id: lobeId,
      iri: root.id,
      label: root.label.replace(/[ _]Lobe$/i, ""),
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
  const graph: BuiltGraph = { nodes: allNodes, links };

  // --- Meta --------------------------------------------------------
  // Namespaces internes marginaux (une ou deux classes égarées) : regroupés
  // sous « Misc » pour ne pas noyer la liste des modules dans le frontend.
  const rawCounts = new Map<string, number>();
  for (const n of graph.nodes) rawCounts.set(n.module, (rawCounts.get(n.module) ?? 0) + 1);
  for (const n of graph.nodes) {
    if (!n.external && n.module !== "Core" && (rawCounts.get(n.module) ?? 0) < 3)
      n.module = "Misc";
  }

  const moduleMap = new Map<string, ModuleInfo>();
  for (const n of graph.nodes) {
    let m = moduleMap.get(n.module);
    if (!m) {
      m = {
        id: n.module,
        namespace: moduleNamespace.get(n.module) ?? "",
        classCount: 0,
        external: n.external,
      };
      moduleMap.set(n.module, m);
    }
    m.classCount++;
  }
  const modules = [...moduleMap.values()].sort((a, b) => {
    if (a.external !== b.external) return a.external ? 1 : -1;
    return b.classCount - a.classCount;
  });

  const ontoInfo: Record<string, string> = {};
  if (reference.ontologyIri) {
    for (const b of q(
      `SELECT ?p ?o WHERE { <${reference.ontologyIri}> ?p ?o . FILTER(isLiteral(?o)) }`
    )) {
      ontoInfo[localName(b.get("p")!.value)] = b.get("o")!.value;
    }
  }
  const fallbackTitle = reference.name.replace(/\.[^.]+$/, "");

  const meta: Meta = {
    project: { id: project.id, name: project.name },
    reference: { ontologyId: reference.ontologyId, name: reference.name },
    ontology: {
      title: ontoInfo["label"] ?? ontoInfo["title"] ?? fallbackTitle,
      description: ontoInfo["description"] ?? ontoInfo["comment"] ?? "",
      version: ontoInfo["versionInfo"] ?? "",
      modified: ontoInfo["modified"] ?? "",
      triples: store.size,
    },
    counts: {
      classes: graph.nodes.length,
      objectProperties: propLabels.size,
      datatypeProperties: datatypePropCount,
    },
    modules,
    lobes: lobeInfos,
    groupLabel,
    prefixes,
    files: files.map((f) => ({
      ontologyId: f.ontologyId,
      name: f.name,
      size: f.size,
      role: f.role,
    })),
  };

  const prefixEntries = Object.entries(prefixes).sort((a, b) => b[1].length - a[1].length);
  const shrink = (iri: string): string => {
    for (const [p, ns] of prefixEntries) {
      if (iri.startsWith(ns)) return `${p}:${iri.slice(ns.length)}`;
    }
    return `<${iri}>`;
  };
  const prefixHeader = Object.entries(prefixes)
    .map(([p, ns]) => `PREFIX ${p}: <${ns}>`)
    .join("\n");

  console.log(
    `[reference] ${project.name}: ${store.size} triplets, ${graph.nodes.length} classes, ` +
      `${links.length} arêtes, ${modules.length} modules, ${lobeInfos.length} ${groupLabel.toLowerCase()} — ${Date.now() - t0} ms`
  );

  return {
    projectId,
    store,
    graph,
    meta,
    prefixes,
    prefixHeader,
    files,
    shrink,
    moduleOf,
  };
}

/* ------------------------------ Cache ------------------------------- */
/* Les stores oxigraph sont volumineux : on n'en garde que quelques-uns,
   reconstruits à la demande (et invalidés dès qu'un projet change).     */

const MAX_CACHED = 3;
const cache = new Map<string, BuiltReference>();

export function getReference(projectId: string): BuiltReference {
  const hit = cache.get(projectId);
  if (hit) {
    // Ré-insertion : la Map garde l'ordre d'insertion = ordre d'éviction.
    cache.delete(projectId);
    cache.set(projectId, hit);
    return hit;
  }
  const built = buildReference(projectId);
  cache.set(projectId, built);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return built;
}

export function invalidateReference(projectId: string): void {
  cache.delete(projectId);
}

onProjectInvalidated(invalidateReference);

/** Vrai si le projet a une référence exploitable (chatbot / mapping / graphe). */
export function hasReference(projectId: string): boolean {
  return referenceFiles(projectId).length > 0;
}

/* --------------------------- Filtrage graphe ------------------------ */

export function filterGraph(
  ref: BuiltReference,
  opts: { modules?: Set<string>; lobes?: Set<string>; edges?: Set<string> }
): BuiltGraph {
  const { modules, lobes, edges } = opts;
  let nodes = ref.graph.nodes;
  if (modules) nodes = nodes.filter((n) => modules.has(n.module));
  if (lobes) {
    nodes = nodes.filter(
      (n) =>
        n.lobes.some((l) => lobes.has(l)) ||
        (lobes.has("none") && n.lobes.length === 0)
    );
  }
  const kept = new Set(nodes.map((n) => n.id));
  const links = ref.graph.links.filter(
    (l) => kept.has(l.source) && kept.has(l.target) && (!edges || edges.has(l.type))
  );
  return { nodes, links };
}

/* ---------------------------- SPARQL -------------------------------- */

function termToJson(t: Term): Record<string, string> {
  if (t.termType === "NamedNode") return { type: "uri", value: t.value };
  if (t.termType === "BlankNode") return { type: "bnode", value: t.value };
  const out: Record<string, string> = { type: "literal", value: t.value };
  if (t.language) out["xml:lang"] = t.language;
  else if (t.datatype && t.datatype.value !== "http://www.w3.org/2001/XMLSchema#string")
    out.datatype = t.datatype.value;
  return out;
}

export function runSparql(ref: BuiltReference, query: string): unknown {
  const result = ref.store.query(query);

  if (typeof result === "boolean") {
    return { type: "boolean", boolean: result };
  }

  if (Array.isArray(result) && (result.length === 0 || result[0] instanceof Map)) {
    const bindings = (result as Map<string, Term>[]).map((b) => {
      const row: Record<string, Record<string, string>> = {};
      for (const [k, v] of b.entries()) row[k] = termToJson(v);
      return row;
    });
    const varsFromQuery = [...query.matchAll(/\?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
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
/* Repli lexical quand le chatbot n'est pas configuré                  */
/* ------------------------------------------------------------------ */

export function chatStub(ref: BuiltReference, message: string): string {
  const words = message
    .toLowerCase()
    .split(/[^a-zà-ÿ0-9]+/i)
    .filter((w) => w.length >= 4);

  const matches: { node: GraphNode; score: number }[] = [];
  if (words.length > 0) {
    for (const n of ref.graph.nodes) {
      const hay = `${n.label} ${n.comment ?? ""}`.toLowerCase();
      const score = words.reduce((acc, w) => acc + (hay.includes(w) ? 1 : 0), 0);
      if (score > 0) matches.push({ node: n, score });
    }
    matches.sort((a, b) => b.score - a.score || b.node.degree - a.node.degree);
  }

  const title = ref.meta.ontology.title;
  const lines: string[] = [];
  lines.push(
    "**⚠️ Demo mode** — the GraphRAG engine is not configured. " +
      "This answer was generated by a simple lexical search over the ontology."
  );
  if (matches.length > 0) {
    lines.push("");
    lines.push(`Here are the ${title} concepts that seem related to your question:`);
    for (const { node } of matches.slice(0, 6)) {
      const desc = node.comment
        ? ` — ${node.comment.slice(0, 180)}${node.comment.length > 180 ? "…" : ""}`
        : "";
      lines.push(`- **${node.label}** _(module ${node.module})_${desc}`);
    }
    lines.push("");
    lines.push("You can explore these concepts in the **Graph** tab.");
  } else {
    lines.push("");
    lines.push("I could not find any matching concept in the reference ontology.");
  }
  return lines.join("\n");
}
