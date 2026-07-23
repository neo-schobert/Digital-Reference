import type { BuiltGraph, ChatMessage, Meta, SparqlResult } from "./types";

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

export async function sendChat(messages: ChatMessage[]): Promise<string> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body.reply as string;
}

export function fileUrl(name: string): string {
  return `/api/files/${encodeURIComponent(name)}`;
}
