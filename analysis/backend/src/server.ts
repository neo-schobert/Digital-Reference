import express from "express";
import { answerChat } from "./chat.js";
import {
  clearChats,
  deleteChat,
  getChat,
  listChats,
  saveChat,
} from "./chatstore.js";
import {
  compareToDr,
  deleteOntology,
  getResult,
  importOntology,
  listOntologies,
  mapToDr,
  mappedFilePath,
} from "./workspace.js";
import cors from "cors";
import {
  buildGraph,
  filePathFor,
  getGraph,
  getMeta,
  listFiles,
  runSparql,
} from "./ontology.js";

const PORT = Number(process.env.DR_BACKEND_PORT ?? 3178);

const app = express();
app.use(cors());
app.use(express.json({ limit: "24mb" }));

/* --- Santé ---------------------------------------------------------- */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/* --- Métadonnées (ontologie, modules/lobes, préfixes, fichiers) ----- */
app.get("/api/meta", (_req, res) => {
  res.json(getMeta());
});

/* --- Graphe filtré par modules et types d'arêtes -------------------- */
app.get("/api/graph", (req, res) => {
  const parseSet = (v: unknown): Set<string> | undefined =>
    typeof v === "string" && v ? new Set(v.split(",").filter(Boolean)) : undefined;
  const modules = parseSet(req.query.modules);
  const lobes = parseSet(req.query.lobes);
  const edges = parseSet(req.query.edges);
  res.json(getGraph({ modules, lobes, edges }));
});

/* --- Fichiers sources ----------------------------------------------- */
app.get("/api/files", (_req, res) => {
  res.json(listFiles().map(({ name, size }) => ({ name, size })));
});

app.get(/^\/api\/files\/(.+)$/, (req, res) => {
  const name = decodeURIComponent(req.params[0]);
  const path = filePathFor(name);
  if (!path) {
    res.status(404).json({ error: `Unknown file: ${name}` });
    return;
  }
  res.type("text/turtle").sendFile(path);
});

/* --- SPARQL (lecture seule) ----------------------------------------- */
app.post("/api/sparql", (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query : "";
  if (!query.trim()) {
    res.status(400).json({ error: "Empty SPARQL query" });
    return;
  }
  try {
    const t0 = Date.now();
    const result = runSparql(query);
    res.json({ ...(result as object), tookMs: Date.now() - t0 });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/* --- Chatbot GraphRAG (retrieval hybride + SPARQL via OpenRouter) --- */
app.post("/api/chat", async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  try {
    res.json(await answerChat(messages));
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/* --- Chatbot en streaming : événements du pipeline en NDJSON --------- */
app.post("/api/chat/stream", async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const emit = (ev: Record<string, unknown>) => {
    res.write(JSON.stringify(ev) + "\n");
  };
  try {
    const out = await answerChat(messages, emit);
    emit({ type: "answer", ...out });
  } catch (e) {
    emit({ type: "error", error: e instanceof Error ? e.message : String(e) });
  }
  res.end();
});

/* --- Historique des conversations (SQLite, persistant) --------------- */
app.get("/api/chats", (_req, res) => {
  res.json(listChats());
});

app.get("/api/chats/:id", (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: "Unknown conversation" });
    return;
  }
  res.json(chat);
});

app.put("/api/chats/:id", (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!messages) {
    res.status(400).json({ error: "messages[] required" });
    return;
  }
  const saved = saveChat(req.params.id, messages);
  if (!saved) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }
  res.json({ ok: true, id: saved.id, title: saved.title });
});

app.delete("/api/chats/:id", (req, res) => {
  res.json({ ok: deleteChat(req.params.id) });
});

app.delete("/api/chats", (_req, res) => {
  res.json({ ok: true, deleted: clearChats() });
});

/* --- Workspace : ontologies importées, comparaison, mapping vers le DR */
app.get("/api/workspace/ontologies", (_req, res) => {
  res.json(listOntologies());
});

app.post("/api/workspace/ontologies", (req, res) => {
  const { id, name, content } = req.body ?? {};
  if (typeof id !== "string" || typeof name !== "string" || typeof content !== "string") {
    res.status(400).json({ error: "id, name and content are required" });
    return;
  }
  try {
    res.json(importOntology(id, name, content));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.delete("/api/workspace/ontologies/:id", (req, res) => {
  res.json({ ok: deleteOntology(req.params.id) });
});

app.get("/api/workspace/ontologies/:id/results", (req, res) => {
  res.json({
    compare: getResult(req.params.id, "compare"),
    mapping: getResult(req.params.id, "mapping"),
  });
});

app.post("/api/workspace/ontologies/:id/compare", async (req, res) => {
  try {
    res.json(await compareToDr(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/workspace/ontologies/:id/map", async (req, res) => {
  try {
    res.json(await mapToDr(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/workspace/ontologies/:id/mapped.ttl", (req, res) => {
  const path = mappedFilePath(req.params.id);
  if (!path) {
    res.status(404).json({ error: "No mapping generated yet" });
    return;
  }
  res.type("text/turtle").download(path, "mapped-to-dr.ttl");
});

/* --- Démarrage ------------------------------------------------------- */
console.log("[server] chargement de l'ontologie…");
buildGraph();
app.listen(PORT, () => {
  console.log(`[server] backend Digital Reference sur http://localhost:${PORT}`);
});
