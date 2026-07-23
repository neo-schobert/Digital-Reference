import express from "express";
import cors from "cors";
import {
  buildGraph,
  chatStub,
  filePathFor,
  getGraph,
  getMeta,
  listFiles,
  runSparql,
} from "./ontology.js";

const PORT = Number(process.env.DR_BACKEND_PORT ?? 3178);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

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

/* --- Chatbot (stub en attendant le GraphRAG) ------------------------ */
app.post("/api/chat", (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const last = [...messages].reverse().find((m) => m?.role === "user");
  const content = typeof last?.content === "string" ? last.content : "";
  // Petite latence artificielle pour un rendu naturel côté UI
  setTimeout(() => {
    res.json({ reply: chatStub(content) });
  }, 400);
});

/* --- Démarrage ------------------------------------------------------- */
console.log("[server] chargement de l'ontologie…");
buildGraph();
app.listen(PORT, () => {
  console.log(`[server] backend Digital Reference sur http://localhost:${PORT}`);
});
