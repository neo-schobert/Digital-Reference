/* Types partagés avec le backend (dupliqués côté back) */

export interface GraphNode {
  id: string;
  label: string;
  module: string;
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

export interface ModuleInfo {
  id: string;
  namespace: string;
  classCount: number;
  external: boolean;
}

export interface LobeInfo {
  id: string;
  iri: string;
  label: string;
  comment?: string;
  classCount: number;
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

/* Résultats SPARQL */

export interface RdfTerm {
  type: "uri" | "literal" | "bnode";
  value: string;
  "xml:lang"?: string;
  datatype?: string;
}

export interface SparqlBindings {
  type: "bindings";
  head: { vars: string[] };
  results: { bindings: Record<string, RdfTerm>[] };
  tookMs?: number;
}

export interface SparqlBoolean {
  type: "boolean";
  boolean: boolean;
  tookMs?: number;
}

export interface SparqlGraph {
  type: "graph";
  triples: { s: RdfTerm; p: RdfTerm; o: RdfTerm }[];
  turtle: string;
  tookMs?: number;
}

export type SparqlResult = SparqlBindings | SparqlBoolean | SparqlGraph;

export interface ChatCitation {
  iri: string;
  label: string;
  module: string;
}

export interface TraceCandidate {
  iri: string;
  label: string;
  module: string;
  kind: string;
  score: number;
  sem: number;
  lex: number;
}

export interface SparqlAttempt {
  attempt: number;
  query: string;
  ok?: boolean;
  rows?: number;
  error?: string;
}

/** Trace des étapes du pipeline GraphRAG (streamée par le backend). */
export interface ChatTrace {
  /** Relance réécrite en question autonome (RAG conversationnel) */
  rewrite?: { standalone: string };
  embed?: { dims: number; preview: number[]; tookMs: number; error?: string };
  retrieval?: { total: number; tookMs: number; candidates: TraceCandidate[] };
  route?: string;
  sparqlAttempts: SparqlAttempt[];
  graph?: { tool: string; detail?: string };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: ChatCitation[];
  sparql?: string;
  sparqlFailed?: boolean;
  trace?: ChatTrace;
}

export interface ChatReply {
  reply: string;
  citations?: ChatCitation[];
  sparql?: string;
  sparqlFailed?: boolean;
  graph?: { tool: string; detail: string };
  route?: string;
}
