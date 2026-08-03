import oxigraph from "oxigraph";
import type { BuiltReference } from "./ontology.js";

/* ------------------------------------------------------------------ */
/* Split structurel : extraction d'un sous-ensemble de classes en un   */
/* fichier Turtle autonome (travail offline sur un projet précis).     */
/*                                                                     */
/* Les règles d'expansion sont VOLONTAIREMENT identiques à celles du   */
/* panneau Split du frontend (GraphTab.tsx) : l'aperçu estompé dans le */
/* graphe correspond exactement au contenu exporté.                    */
/* Ordre : graines → descendants (subClassOf) → N sauts de propriétés  */
/* → ancêtres. L'export relit le store oxigraph (et non le graphe de   */
/* viz) pour conserver labels, commentaires et annotations.            */
/* ------------------------------------------------------------------ */

export interface SplitRequest {
  name?: string;
  seeds?: string[];
  /** fermeture descendante subClassOf (défaut true) */
  subclasses?: boolean;
  /** chaîne des parents jusqu'à la racine (défaut true) */
  superclasses?: boolean;
  /** sauts de voisinage via object properties (défaut 0, max 3) */
  hops?: number;
  /** autoriser les classes externes (SOSA, Schema.org…) dans l'expansion */
  includeExternal?: boolean;
}

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
const LANG_STRING = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";

function clampHops(h: unknown): number {
  const n = typeof h === "number" ? Math.trunc(h) : 0;
  return Math.max(0, Math.min(3, n));
}

function computeMembers(ref: BuiltReference, req: SplitRequest): Set<string> {
  const { nodes, links } = ref.graph;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const allowed = (id: string) => {
    const n = byId.get(id);
    return n !== undefined && (req.includeExternal === true || !n.external);
  };

  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const propNb = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, v: string) => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };
  for (const l of links) {
    if (l.type === "subclass") {
      add(parents, l.source, l.target);
      add(children, l.target, l.source);
    } else {
      add(propNb, l.source, l.target);
      add(propNb, l.target, l.source);
    }
  }

  const members = new Set((req.seeds ?? []).filter((id) => byId.has(id)));
  const grow = (adj: Map<string, string[]>) => {
    const stack = [...members];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const nb of adj.get(cur) ?? []) {
        if (!members.has(nb) && allowed(nb)) {
          members.add(nb);
          stack.push(nb);
        }
      }
    }
  };

  if (req.subclasses !== false) grow(children);
  const hops = clampHops(req.hops);
  for (let h = 0; h < hops; h++) {
    const frontier: string[] = [];
    for (const id of members) {
      for (const nb of propNb.get(id) ?? []) {
        if (!members.has(nb) && allowed(nb)) frontier.push(nb);
      }
    }
    for (const id of frontier) members.add(id);
  }
  if (req.superclasses !== false) grow(parents);
  return members;
}

type Term = {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
};

export function buildSplit(
  ref: BuiltReference,
  req: SplitRequest
): { filename: string; ttl: string } {
  const seeds = (req.seeds ?? []).filter((s): s is string => typeof s === "string");
  if (seeds.length === 0) throw new Error("At least one seed class is required");
  const members = computeMembers(ref, { ...req, seeds });
  if (members.size === 0) throw new Error("No known class matches the given seeds");

  const { nodes, links } = ref.graph;
  const { store, prefixes: PREFIXES } = ref;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Propriétés pertinentes : object properties dont au moins une arête a ses
  // deux extrémités dans le split ; datatype properties des classes gardées.
  const objProps = new Set<string>();
  for (const l of links) {
    if (l.type === "property" && l.iri && members.has(l.source) && members.has(l.target)) {
      objProps.add(l.iri);
    }
  }
  const dtProps = new Set<string>();
  for (const id of members) {
    for (const a of nodeById.get(id)?.attributes ?? []) dtProps.add(a.iri);
  }

  /* ---- Sérialisation Turtle (préfixes compactés, sortie lisible) ---- */
  const prefixEntries = Object.entries(PREFIXES).sort((a, b) => b[1].length - a[1].length);
  const used = new Set<string>(["owl", "rdfs", "terms", "xsd"]);
  const LOCAL_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
  const iri = (v: string): string => {
    for (const [p, ns] of prefixEntries) {
      if (v.startsWith(ns)) {
        const local = v.slice(ns.length);
        if (LOCAL_RE.test(local)) {
          used.add(p);
          return `${p}:${local}`;
        }
      }
    }
    return `<${v}>`;
  };
  const escStr = (v: string): string =>
    v
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
  const lit = (t: Term): string => {
    const v = `"${escStr(t.value)}"`;
    if (t.language) return `${v}@${t.language}`;
    const dt = t.datatype?.value;
    if (dt && dt !== XSD_STRING && dt !== LANG_STRING) return `${v}^^${iri(dt)}`;
    return v;
  };

  // Un bloc par sujet : `a` d'abord, puis subClassOf, puis le reste trié.
  const emitSubject = (
    subject: string,
    keep: (predicate: string, object: Term) => string | null
  ): string | null => {
    const po = new Map<string, string[]>();
    const quads = store.match(oxigraph.namedNode(subject)) as unknown as {
      predicate: Term;
      object: Term;
    }[];
    for (const quad of quads) {
      const rendered = keep(quad.predicate.value, quad.object);
      if (rendered === null) continue;
      const p = quad.predicate.value === RDF_TYPE ? "a" : iri(quad.predicate.value);
      const arr = po.get(p);
      if (arr) {
        if (!arr.includes(rendered)) arr.push(rendered);
      } else po.set(p, [rendered]);
    }
    if (po.size === 0) return null;
    const order = (p: string) => (p === "a" ? "0" : p === "rdfs:subClassOf" ? "1" : `2${p}`);
    const preds = [...po.keys()].sort((x, y) => order(x).localeCompare(order(y)));
    const body = preds.map((p) => `  ${p} ${po.get(p)!.sort().join(", ")}`).join(" ;\n");
    return `${iri(subject)}\n${body} .\n`;
  };

  const keepAnnotationIri = new Set([`${RDFS}seeAlso`, `${RDFS}isDefinedBy`]);

  const classBlocks: string[] = [];
  for (const id of [...members].sort((a, b) => iri(a).localeCompare(iri(b)))) {
    const block = emitSubject(id, (p, o) => {
      if (o.termType === "Literal") return lit(o);
      if (o.termType !== "NamedNode") return null; // restrictions (bnodes) hors périmètre
      if (p === RDF_TYPE) return o.value === `${OWL}Class` ? "owl:Class" : null;
      if (p === `${RDFS}subClassOf` || p === `${OWL}equivalentClass` || p === `${OWL}disjointWith`)
        return members.has(o.value) ? iri(o.value) : null;
      if (keepAnnotationIri.has(p)) return iri(o.value);
      return null;
    });
    if (block) classBlocks.push(block);
  }

  const propBlock = (pIri: string, kind: "object" | "datatype"): string | null =>
    emitSubject(pIri, (p, o) => {
      if (o.termType === "Literal") return lit(o);
      if (o.termType !== "NamedNode") return null;
      if (p === RDF_TYPE)
        return o.value.startsWith(OWL) && o.value.endsWith("Property") ? iri(o.value) : null;
      if (p === `${RDFS}domain`) return members.has(o.value) ? iri(o.value) : null;
      if (p === `${RDFS}range`)
        return kind === "datatype" || members.has(o.value) ? iri(o.value) : null;
      if (p === `${RDFS}subPropertyOf`)
        return (kind === "object" ? objProps : dtProps).has(o.value) ? iri(o.value) : null;
      if (keepAnnotationIri.has(p)) return iri(o.value);
      return null;
    });

  const objBlocks = [...objProps]
    .sort()
    .map((p) => propBlock(p, "object"))
    .filter((b): b is string => b !== null);
  const dtBlocks = [...dtProps]
    .sort()
    .map((p) => propBlock(p, "datatype"))
    .filter((b): b is string => b !== null);

  /* ---- En-tête : provenance complète (source, graines, règles) ---- */
  const meta = ref.meta;
  const title = meta.ontology.title;
  const name = (req.name ?? "").trim() || `${title} split`;
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "ontology-split";
  const hops = clampHops(req.hops);
  const rules =
    [
      req.subclasses !== false ? "subclasses" : null,
      req.superclasses !== false ? "superclasses" : null,
      hops > 0 ? `${hops} property hop${hops > 1 ? "s" : ""}` : null,
      req.includeExternal ? "external classes" : null,
    ]
      .filter(Boolean)
      .join(", ") || "seeds only";
  const seedLabels = seeds.map((s) => nodeById.get(s)?.label ?? s).join(", ");
  const now = new Date().toISOString();

  const sourceIri = ref.files.find((f) => f.role === "reference")?.ontologyIri;
  const splitIri = sourceIri
    ? `${sourceIri.replace(/[#/]$/, "")}/split/${slug}`
    : `urn:ontology-explorer:split:${slug}`;
  const header =
    `<${splitIri}> a owl:Ontology ;\n` +
    `  rdfs:label "${escStr(name)} — ${escStr(title)} split"@en ;\n` +
    `  rdfs:comment "${escStr(
      `Standalone structural split of ${title}, generated by Ontology Explorer. ` +
        `Seeds: ${seedLabels}. Expansion: ${rules}. ` +
        `${members.size} classes, ${objProps.size} object properties, ${dtProps.size} datatype properties.`
    )}"@en ;\n` +
    `  owl:versionInfo "split of ${escStr(title)} ${escStr(meta.ontology.version)}" ;\n` +
    (sourceIri ? `  terms:source <${sourceIri}> ;\n` : "") +
    `  terms:created "${now}"^^xsd:dateTime .\n`;

  const prefixHeader = Object.entries(PREFIXES)
    .filter(([p]) => used.has(p))
    .map(([p, ns]) => `@prefix ${p}: <${ns}> .`)
    .join("\n");

  const ttl =
    `# ${name} — structural split of ${title} (${meta.ontology.version})\n` +
    `# Generated by Ontology Explorer on ${now}\n\n` +
    `${prefixHeader}\n\n${header}\n` +
    `### Classes (${classBlocks.length})\n\n${classBlocks.join("\n")}\n` +
    (objBlocks.length > 0
      ? `### Object properties (${objBlocks.length})\n\n${objBlocks.join("\n")}\n`
      : "") +
    (dtBlocks.length > 0
      ? `### Datatype properties (${dtBlocks.length})\n\n${dtBlocks.join("\n")}`
      : "");

  return { filename: `${slug}.ttl`, ttl };
}
