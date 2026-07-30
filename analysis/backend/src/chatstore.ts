import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

/* ------------------------------------------------------------------ */
/* Persistance des conversations du chatbot : SQLite natif de Node     */
/* (node:sqlite, aucune dépendance). Base dans analysis/.data/,        */
/* git-ignorée, survit aux redémarrages du backend et du frontend.     */
/* ------------------------------------------------------------------ */

// node:sqlite est expérimental : pas encore dans @types/node → import non typé
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { DatabaseSync } = require("node:sqlite") as any;

const DATA_DIR = resolve(join(import.meta.dirname, "..", "..", ".data"));
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, "chats.db"));
export { DATA_DIR };
db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    data          TEXT NOT NULL
  )
`);

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface StoredChat extends ChatSummary {
  /** Messages tels qu'affichés par le frontend (contenu, citations, trace…) */
  messages: unknown[];
}

const VALID_ID = /^[A-Za-z0-9-]{8,64}$/;

function titleFrom(messages: unknown[]): string {
  for (const m of messages) {
    const msg = m as { role?: string; content?: string };
    if (msg?.role === "user" && typeof msg.content === "string") {
      const t = msg.content.replace(/\s+/g, " ").trim();
      return t.length > 60 ? t.slice(0, 57) + "…" : t || "New conversation";
    }
  }
  return "New conversation";
}

export function listChats(): ChatSummary[] {
  const rows = db
    .prepare(
      `SELECT id, title, created_at, updated_at, message_count
       FROM chats ORDER BY updated_at DESC`
    )
    .all() as {
    id: string;
    title: string;
    created_at: number;
    updated_at: number;
    message_count: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count,
  }));
}

export function getChat(id: string): StoredChat | null {
  if (!VALID_ID.test(id)) return null;
  const row = db
    .prepare(
      `SELECT id, title, created_at, updated_at, message_count, data
       FROM chats WHERE id = ?`
    )
    .get(id) as
    | {
        id: string;
        title: string;
        created_at: number;
        updated_at: number;
        message_count: number;
        data: string;
      }
    | undefined;
  if (!row) return null;
  let messages: unknown[] = [];
  try {
    messages = JSON.parse(row.data);
  } catch {
    /* base corrompue : renvoyer une conversation vide plutôt que planter */
  }
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    messages,
  };
}

export function saveChat(id: string, messages: unknown[]): StoredChat | null {
  if (!VALID_ID.test(id) || !Array.isArray(messages)) return null;
  const now = Date.now();
  const title = titleFrom(messages);
  const data = JSON.stringify(messages);
  db.prepare(
    `INSERT INTO chats (id, title, created_at, updated_at, message_count, data)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       updated_at = excluded.updated_at,
       message_count = excluded.message_count,
       data = excluded.data`
  ).run(id, title, now, now, messages.length, data);
  return getChat(id);
}

export function deleteChat(id: string): boolean {
  if (!VALID_ID.test(id)) return false;
  const res = db.prepare(`DELETE FROM chats WHERE id = ?`).run(id);
  return Number(res.changes) > 0;
}

export function clearChats(): number {
  const res = db.prepare(`DELETE FROM chats`).run();
  return Number(res.changes);
}
