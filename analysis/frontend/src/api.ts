import type { BuiltGraph, ChatMessage, ChatReply, Meta, SparqlResult } from "./types";

/* Toutes les routes sont relatives à un PROJET : un projet = une ontologie
   de référence + les ontologies importées qu'on lui compare. */

const P = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* corps non-JSON */
  }
  return `${res.status} ${res.statusText}`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

async function sendJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/* ------------------------------ Projets ----------------------------- */

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  /** null tant qu'aucune ontologie du projet n'est désignée comme référence */
  referenceId: string | null;
  referenceName: string | null;
  /** true dès qu'une comparaison ou un mapping existe : référence figée */
  referenceLocked: boolean;
  ontologyCount: number;
  chatCount: number;
}

export function listProjects(): Promise<Project[]> {
  return getJson<Project[]>("/api/projects");
}

export function createProject(name: string, description = ""): Promise<Project> {
  return sendJson<Project>("/api/projects", "POST", {
    id: crypto.randomUUID(),
    name,
    description,
  });
}

export function updateProject(
  id: string,
  patch: { name?: string; description?: string; referenceId?: string | null }
): Promise<Project> {
  return sendJson<Project>(P(id), "PATCH", patch);
}

export function deleteProject(id: string): Promise<{ ok: boolean }> {
  return sendJson<{ ok: boolean }>(P(id), "DELETE");
}

/* ------------------ Référence : meta, graphe, SPARQL ----------------- */

export function fetchMeta(projectId: string): Promise<Meta> {
  return getJson<Meta>(`${P(projectId)}/meta`);
}

export function fetchGraph(
  projectId: string,
  opts: { modules?: string[]; lobes?: string[]; edges?: string[] } = {}
): Promise<BuiltGraph> {
  const params = new URLSearchParams();
  if (opts.modules) params.set("modules", opts.modules.join(","));
  if (opts.lobes) params.set("lobes", opts.lobes.join(","));
  if (opts.edges) params.set("edges", opts.edges.join(","));
  return getJson<BuiltGraph>(`${P(projectId)}/graph?${params.toString()}`);
}

export function runSparql(projectId: string, query: string): Promise<SparqlResult> {
  return sendJson<SparqlResult>(`${P(projectId)}/sparql`, "POST", { query });
}

/* ------------------- Ontologies importées du projet ------------------ */

export interface ProjectOntology {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  triples: number;
  classes: number;
  properties: number;
  /** ids des ontologies du projet dont celle-ci dépend */
  deps: string[];
  isReference: boolean;
  /** true si elle fait partie de la référence (elle-même ou une dépendance) */
  inReference: boolean;
  ontologyIri?: string;
  namespaces: string[];
  hasCompare: boolean;
  hasMapping: boolean;
  linkScore?: number;
  similarityScore?: number;
}

export function listOntologies(projectId: string): Promise<ProjectOntology[]> {
  return getJson<ProjectOntology[]>(`${P(projectId)}/ontologies`);
}

export function importOntology(
  projectId: string,
  name: string,
  content: string,
  deps: string[] = []
): Promise<ProjectOntology> {
  return sendJson<ProjectOntology>(`${P(projectId)}/ontologies`, "POST", {
    id: crypto.randomUUID(),
    name,
    content,
    deps,
  });
}

export function patchOntology(
  projectId: string,
  id: string,
  patch: { deps?: string[]; name?: string }
): Promise<ProjectOntology> {
  return sendJson<ProjectOntology>(
    `${P(projectId)}/ontologies/${encodeURIComponent(id)}`,
    "PATCH",
    patch
  );
}

export function deleteOntology(projectId: string, id: string): Promise<{ ok: boolean }> {
  return sendJson<{ ok: boolean }>(
    `${P(projectId)}/ontologies/${encodeURIComponent(id)}`,
    "DELETE"
  );
}

/* ---------------- Comparaison et mapping à la référence -------------- */

/** Scores par facette (matchers indépendants, voir backend/similarity.ts) */
export interface FacetSummary {
  lexical: number;
  structural?: number;
  semantic?: number;
}

export interface CompareReport {
  createdAt: number;
  totalClasses: number;
  analyzed: number;
  truncated: number;
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

export interface MappingEntry {
  source: string;
  sourceIri: string;
  relation: "equivalent" | "subclass" | "related" | "none";
  target?: string;
  targetIri?: string;
  confidence?: number;
  score?: number;
  facets?: FacetSummary;
  importance?: number;
}

export interface MappingReport {
  createdAt: number;
  totalClasses: number;
  truncated: number;
  linkScore: number;
  counts: { equivalent: number; subclass: number; related: number; none: number };
  entries: MappingEntry[];
  file: string;
  sssomFile?: string;
}

export function loadResults(
  projectId: string,
  id: string
): Promise<{ compare: CompareReport | null; mapping: MappingReport | null }> {
  return getJson(`${P(projectId)}/ontologies/${encodeURIComponent(id)}/results`);
}

export function compareOntology(projectId: string, id: string): Promise<CompareReport> {
  return sendJson<CompareReport>(
    `${P(projectId)}/ontologies/${encodeURIComponent(id)}/compare`,
    "POST"
  );
}

export function mapOntology(projectId: string, id: string): Promise<MappingReport> {
  return sendJson<MappingReport>(
    `${P(projectId)}/ontologies/${encodeURIComponent(id)}/map`,
    "POST"
  );
}

export function fetchOntologyGraph(
  projectId: string,
  id: string,
  version: "original" | "mapped"
): Promise<BuiltGraph> {
  return getJson<BuiltGraph>(
    `${P(projectId)}/ontologies/${encodeURIComponent(id)}/graph?version=${version}`
  );
}

export function mappedTtlUrl(projectId: string, id: string): string {
  return `${P(projectId)}/ontologies/${encodeURIComponent(id)}/mapped.ttl`;
}

export function sssomTsvUrl(projectId: string, id: string): string {
  return `${P(projectId)}/ontologies/${encodeURIComponent(id)}/mappings.sssom.tsv`;
}

export function ontologyFileUrl(projectId: string, id: string): string {
  return `${P(projectId)}/ontologies/${encodeURIComponent(id)}/source`;
}

/* ------------------------------ Chatbot ------------------------------ */

export interface ChatContext {
  /** ids d'ontologies du projet à inclure dans le retrieval */
  ontologies: string[];
}

export async function sendChat(
  projectId: string,
  messages: ChatMessage[],
  context?: ChatContext
): Promise<ChatReply> {
  return sendJson<ChatReply>(`${P(projectId)}/chat`, "POST", {
    // L'historique envoyé ne garde que role/content (citations = décor local)
    messages: messages.map(({ role, content }) => ({ role, content })),
    context,
  });
}

/**
 * Variante streamée : le backend émet les événements du pipeline en NDJSON
 * (vectorisation, retrieval, SPARQL…) puis l'événement final `answer`.
 */
export async function streamChat(
  projectId: string,
  messages: ChatMessage[],
  onEvent: (ev: Record<string, unknown>) => void,
  context?: ChatContext
): Promise<ChatReply> {
  const res = await fetch(`${P(projectId)}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: messages.map(({ role, content }) => ({ role, content })),
      context,
    }),
  });
  if (!res.ok || !res.body) throw new Error(await readError(res));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: ChatReply | null = null;
  let error: string | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "answer") final = ev as unknown as ChatReply;
      else if (ev.type === "error") error = String(ev.error);
      else onEvent(ev);
    }
  }
  if (error) throw new Error(error);
  if (!final) throw new Error("Stream ended without an answer");
  return final;
}

/* ---- Historique des conversations du projet (persisté côté backend) ---- */

export interface ChatSummary {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export function listChats(projectId: string): Promise<ChatSummary[]> {
  return getJson<ChatSummary[]>(`${P(projectId)}/chats`);
}

export function loadChat(
  projectId: string,
  id: string
): Promise<ChatSummary & { messages: ChatMessage[] }> {
  return getJson(`${P(projectId)}/chats/${encodeURIComponent(id)}`);
}

export async function saveChat(
  projectId: string,
  id: string,
  messages: ChatMessage[]
): Promise<void> {
  await sendJson(`${P(projectId)}/chats/${encodeURIComponent(id)}`, "PUT", { messages });
}

export async function deleteChat(projectId: string, id: string): Promise<void> {
  await sendJson(`${P(projectId)}/chats/${encodeURIComponent(id)}`, "DELETE");
}

export async function clearChats(projectId: string): Promise<void> {
  await sendJson(`${P(projectId)}/chats`, "DELETE");
}

/* ---- Split structurel : export d'un sous-ensemble en Turtle ---- */

export interface SplitExportRequest {
  name: string;
  seeds: string[];
  subclasses: boolean;
  superclasses: boolean;
  hops: number;
  includeExternal: boolean;
}

export async function exportSplit(
  projectId: string,
  req: SplitExportRequest
): Promise<Blob> {
  const res = await fetch(`${P(projectId)}/split/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.blob();
}
