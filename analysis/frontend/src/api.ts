import type { BuiltGraph, ChatMessage, ChatReply, Meta, SparqlResult } from "./types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function fetchMeta(): Promise<Meta> {
  return getJson<Meta>("/api/meta");
}

export function fetchGraph(opts: {
  modules?: string[];
  lobes?: string[];
  edges?: string[];
}): Promise<BuiltGraph> {
  const params = new URLSearchParams();
  if (opts.modules) params.set("modules", opts.modules.join(","));
  if (opts.lobes) params.set("lobes", opts.lobes.join(","));
  if (opts.edges) params.set("edges", opts.edges.join(","));
  return getJson<BuiltGraph>(`/api/graph?${params.toString()}`);
}

export async function runSparql(query: string): Promise<SparqlResult> {
  const res = await fetch("/api/sparql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body as SparqlResult;
}

export async function sendChat(messages: ChatMessage[]): Promise<ChatReply> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // L'historique envoyé ne garde que role/content (citations = décor local)
    body: JSON.stringify({
      messages: messages.map(({ role, content }) => ({ role, content })),
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body as ChatReply;
}

/**
 * Variante streamée : le backend émet les événements du pipeline en NDJSON
 * (vectorisation, retrieval, SPARQL…) puis l'événement final `answer`.
 */
export async function streamChat(
  messages: ChatMessage[],
  onEvent: (ev: Record<string, unknown>) => void
): Promise<ChatReply> {
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: messages.map(({ role, content }) => ({ role, content })),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
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

/* ---- Historique des conversations (persisté côté backend) ---- */

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export function listChats(): Promise<ChatSummary[]> {
  return getJson<ChatSummary[]>("/api/chats");
}

export function loadChat(
  id: string
): Promise<ChatSummary & { messages: ChatMessage[] }> {
  return getJson(`/api/chats/${encodeURIComponent(id)}`);
}

export async function saveChat(id: string, messages: ChatMessage[]): Promise<void> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

export async function deleteChat(id: string): Promise<void> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

export async function clearChats(): Promise<void> {
  const res = await fetch("/api/chats", { method: "DELETE" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

/* ---- Workspace : ontologies importées, comparaison, mapping DR ---- */

export interface WsOntology {
  id: string;
  name: string;
  createdAt: number;
  triples: number;
  classes: number;
  properties: number;
  hasCompare: boolean;
  hasMapping: boolean;
  linkScore?: number;
  similarityScore?: number;
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
  }[];
}

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
  linkScore: number;
  counts: { equivalent: number; subclass: number; related: number; none: number };
  entries: MappingEntry[];
  file: string;
}

export function listWsOntologies(): Promise<WsOntology[]> {
  return getJson<WsOntology[]>("/api/workspace/ontologies");
}

export async function importWsOntology(
  id: string,
  name: string,
  content: string
): Promise<WsOntology> {
  const res = await fetch("/api/workspace/ontologies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name, content }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body as WsOntology;
}

export async function deleteWsOntology(id: string): Promise<void> {
  const res = await fetch(`/api/workspace/ontologies/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

export function loadWsResults(
  id: string
): Promise<{ compare: CompareReport | null; mapping: MappingReport | null }> {
  return getJson(`/api/workspace/ontologies/${encodeURIComponent(id)}/results`);
}

async function postJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "POST" });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export function compareOntology(id: string): Promise<CompareReport> {
  return postJson(`/api/workspace/ontologies/${encodeURIComponent(id)}/compare`);
}

export function mapOntology(id: string): Promise<MappingReport> {
  return postJson(`/api/workspace/ontologies/${encodeURIComponent(id)}/map`);
}

export function mappedTtlUrl(id: string): string {
  return `/api/workspace/ontologies/${encodeURIComponent(id)}/mapped.ttl`;
}

export function fileUrl(name: string): string {
  return `/api/files/${encodeURIComponent(name)}`;
}
