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

export function fileUrl(name: string): string {
  return `/api/files/${encodeURIComponent(name)}`;
}
