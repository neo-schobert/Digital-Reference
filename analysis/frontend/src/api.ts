import type { BuiltGraph, ChatMessage, ChatReply, Meta, SparqlResult } from "./types";
import { apiHeaders, apiUrl } from "./settings";

/* Toutes les routes sont relatives à un PROJET : un projet = une ontologie
   de référence + les ontologies importées qu'on lui compare. */

const P = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
const LEGACY_PROJECT_ID = "legacy-default";

type BackendMode = "unknown" | "projects" | "legacy";
let backendMode: BackendMode = "unknown";

async function detectBackendMode(): Promise<BackendMode> {
  if (backendMode !== "unknown") return backendMode;
  const target = apiUrl("/api/projects");
  try {
    const res = await fetch(target, { headers: apiHeaders(target) });
    if (res.status === 404) {
      backendMode = "legacy";
      return backendMode;
    }
    backendMode = "projects";
    return backendMode;
  } catch {
    // Keep unknown so normal requests surface the real network error.
    return backendMode;
  }
}

function isLegacyMode(projectId?: string): boolean {
  return backendMode === "legacy" || projectId === LEGACY_PROJECT_ID;
}

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
  const target = apiUrl(url);
  const res = await fetch(target, { headers: apiHeaders(target) });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

async function sendJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const target = apiUrl(url);
  const res = await fetch(target, {
    method,
    headers: apiHeaders(
      target,
      body === undefined ? undefined : { "Content-Type": "application/json" }
    ),
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
  return detectBackendMode().then(async (mode) => {
    if (mode === "legacy") {
      return [
        {
          id: LEGACY_PROJECT_ID,
          name: "Default Project",
          description: "Legacy backend compatibility mode",
          createdAt: 0,
          referenceId: null,
          referenceName: "Digital Reference",
          referenceLocked: false,
          ontologyCount: 0,
          chatCount: 0,
        },
      ];
    }
    return getJson<Project[]>("/api/projects");
  });
}

export function createProject(name: string, description = ""): Promise<Project> {
  if (isLegacyMode()) {
    return Promise.resolve({
      id: LEGACY_PROJECT_ID,
      name: name || "Default Project",
      description,
      createdAt: Date.now(),
      referenceId: null,
      referenceName: "Digital Reference",
      referenceLocked: false,
      ontologyCount: 0,
      chatCount: 0,
    });
  }
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
  if (isLegacyMode(id)) {
    return Promise.resolve({
      id: LEGACY_PROJECT_ID,
      name: patch.name ?? "Default Project",
      description: patch.description ?? "Legacy backend compatibility mode",
      createdAt: 0,
      referenceId: null,
      referenceName: "Digital Reference",
      referenceLocked: false,
      ontologyCount: 0,
      chatCount: 0,
    });
  }
  return sendJson<Project>(P(id), "PATCH", patch);
}

export function deleteProject(id: string): Promise<{ ok: boolean }> {
  if (isLegacyMode(id)) return Promise.resolve({ ok: true });
  return sendJson<{ ok: boolean }>(P(id), "DELETE");
}

/* ------------------ Référence : meta, graphe, SPARQL ----------------- */

export function fetchMeta(projectId: string): Promise<Meta> {
  if (isLegacyMode(projectId)) return getJson<Meta>("/api/meta");
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
  if (isLegacyMode(projectId)) return getJson<BuiltGraph>(`/api/graph?${params.toString()}`);
  return getJson<BuiltGraph>(`${P(projectId)}/graph?${params.toString()}`);
}

export function runSparql(projectId: string, query: string): Promise<SparqlResult> {
  if (isLegacyMode(projectId)) return sendJson<SparqlResult>("/api/sparql", "POST", { query });
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
  if (isLegacyMode(projectId)) {
    return getJson<ProjectOntology[]>("/api/workspace/ontologies").then((list) =>
      list.map((o) => ({ ...o, projectId: LEGACY_PROJECT_ID, deps: [], isReference: false, inReference: false, namespaces: [] }))
    );
  }
  return getJson<ProjectOntology[]>(`${P(projectId)}/ontologies`);
}

export function importOntology(
  projectId: string,
  name: string,
  content: string,
  deps: string[] = []
): Promise<ProjectOntology> {
  if (isLegacyMode(projectId)) {
    return sendJson<ProjectOntology>("/api/workspace/ontologies", "POST", {
      id: crypto.randomUUID(),
      name,
      content,
    }).then((o) => ({ ...o, projectId: LEGACY_PROJECT_ID, deps: [], isReference: false, inReference: false, namespaces: [] }));
  }
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
  if (isLegacyMode(projectId)) {
    return listOntologies(projectId).then((list) => {
      const current = list.find((x) => x.id === id);
      if (!current) throw new Error("Unknown ontology");
      return { ...current, name: patch.name ?? current.name };
    });
  }
  return sendJson<ProjectOntology>(
    `${P(projectId)}/ontologies/${encodeURIComponent(id)}`,
    "PATCH",
    patch
  );
}

export function deleteOntology(projectId: string, id: string): Promise<{ ok: boolean }> {
  if (isLegacyMode(projectId)) {
    return sendJson<{ ok: boolean }>(`/api/workspace/ontologies/${encodeURIComponent(id)}`, "DELETE");
  }
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
  if (isLegacyMode(projectId)) return getJson(`/api/workspace/ontologies/${encodeURIComponent(id)}/results`);
  return getJson(`${P(projectId)}/ontologies/${encodeURIComponent(id)}/results`);
}

export function compareOntology(projectId: string, id: string): Promise<CompareReport> {
  if (isLegacyMode(projectId)) {
    return sendJson<CompareReport>(`/api/workspace/ontologies/${encodeURIComponent(id)}/compare`, "POST");
  }
  return sendJson<CompareReport>(
    `${P(projectId)}/ontologies/${encodeURIComponent(id)}/compare`,
    "POST"
  );
}

export function mapOntology(projectId: string, id: string): Promise<MappingReport> {
  if (isLegacyMode(projectId)) {
    return sendJson<MappingReport>(`/api/workspace/ontologies/${encodeURIComponent(id)}/map`, "POST");
  }
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
  if (isLegacyMode(projectId)) {
    return getJson<BuiltGraph>(
      `/api/workspace/ontologies/${encodeURIComponent(id)}/graph?version=${version}`
    );
  }
  return getJson<BuiltGraph>(
    `${P(projectId)}/ontologies/${encodeURIComponent(id)}/graph?version=${version}`
  );
}

export function mappedTtlUrl(projectId: string, id: string): string {
  if (isLegacyMode(projectId)) {
    return apiUrl(`/api/workspace/ontologies/${encodeURIComponent(id)}/mapped.ttl`);
  }
  return apiUrl(`${P(projectId)}/ontologies/${encodeURIComponent(id)}/mapped.ttl`);
}

export function sssomTsvUrl(projectId: string, id: string): string {
  if (isLegacyMode(projectId)) {
    return apiUrl(`/api/workspace/ontologies/${encodeURIComponent(id)}/mappings.sssom.tsv`);
  }
  return apiUrl(`${P(projectId)}/ontologies/${encodeURIComponent(id)}/mappings.sssom.tsv`);
}

export function ontologyFileUrl(projectId: string, id: string): string {
  if (isLegacyMode(projectId)) {
    return apiUrl(`/api/workspace/ontologies/${encodeURIComponent(id)}/mapped.ttl`);
  }
  return apiUrl(`${P(projectId)}/ontologies/${encodeURIComponent(id)}/source`);
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
  if (isLegacyMode(projectId)) {
    return sendJson<ChatReply>("/api/chat", "POST", {
      messages: messages.map(({ role, content }) => ({ role, content })),
      context,
    });
  }
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
  if (isLegacyMode(projectId)) {
    const targetLegacy = apiUrl(`/api/chat/stream`);
    const resLegacy = await fetch(targetLegacy, {
      method: "POST",
      headers: apiHeaders(targetLegacy, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        messages: messages.map(({ role, content }) => ({ role, content })),
        context,
      }),
    });
    if (!resLegacy.ok || !resLegacy.body) throw new Error(await readError(resLegacy));
    const readerLegacy = resLegacy.body.getReader();
    const decoderLegacy = new TextDecoder();
    let bufferLegacy = "";
    let finalLegacy: ChatReply | null = null;
    let errorLegacy: string | null = null;
    for (;;) {
      const { done, value } = await readerLegacy.read();
      if (done) break;
      bufferLegacy += decoderLegacy.decode(value, { stream: true });
      let nl;
      while ((nl = bufferLegacy.indexOf("\n")) >= 0) {
        const line = bufferLegacy.slice(0, nl).trim();
        bufferLegacy = bufferLegacy.slice(nl + 1);
        if (!line) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "answer") finalLegacy = ev as unknown as ChatReply;
        else if (ev.type === "error") errorLegacy = String(ev.error);
        else onEvent(ev);
      }
    }
    if (errorLegacy) throw new Error(errorLegacy);
    if (!finalLegacy) throw new Error("Stream ended without an answer");
    return finalLegacy;
  }

  const target = apiUrl(`${P(projectId)}/chat/stream`);
  const res = await fetch(target, {
    method: "POST",
    headers: apiHeaders(target, { "Content-Type": "application/json" }),
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
  if (isLegacyMode(projectId)) {
    return getJson<ChatSummary[]>(`/api/chats`).then((list) =>
      list.map((c) => ({ ...c, projectId: LEGACY_PROJECT_ID }))
    );
  }
  return getJson<ChatSummary[]>(`${P(projectId)}/chats`);
}

export function loadChat(
  projectId: string,
  id: string
): Promise<ChatSummary & { messages: ChatMessage[] }> {
  if (isLegacyMode(projectId)) {
    return getJson<ChatSummary & { messages: ChatMessage[] }>(`/api/chats/${encodeURIComponent(id)}`).then((c) => ({
      ...c,
      projectId: LEGACY_PROJECT_ID,
    }));
  }
  return getJson(`${P(projectId)}/chats/${encodeURIComponent(id)}`);
}

export async function saveChat(
  projectId: string,
  id: string,
  messages: ChatMessage[]
): Promise<void> {
  if (isLegacyMode(projectId)) {
    await sendJson(`/api/chats/${encodeURIComponent(id)}`, "PUT", { messages });
    return;
  }
  await sendJson(`${P(projectId)}/chats/${encodeURIComponent(id)}`, "PUT", { messages });
}

export async function deleteChat(projectId: string, id: string): Promise<void> {
  if (isLegacyMode(projectId)) {
    await sendJson(`/api/chats/${encodeURIComponent(id)}`, "DELETE");
    return;
  }
  await sendJson(`${P(projectId)}/chats/${encodeURIComponent(id)}`, "DELETE");
}

export async function clearChats(projectId: string): Promise<void> {
  if (isLegacyMode(projectId)) {
    await sendJson(`/api/chats`, "DELETE");
    return;
  }
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
  if (isLegacyMode(projectId)) {
    const targetLegacy = apiUrl(`/api/split/export`);
    const resLegacy = await fetch(targetLegacy, {
      method: "POST",
      headers: apiHeaders(targetLegacy, { "Content-Type": "application/json" }),
      body: JSON.stringify(req),
    });
    if (!resLegacy.ok) throw new Error(await readError(resLegacy));
    return resLegacy.blob();
  }

  const target = apiUrl(`${P(projectId)}/split/export`);
  const res = await fetch(target, {
    method: "POST",
    headers: apiHeaders(target, { "Content-Type": "application/json" }),
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.blob();
}
