import express, { type Request, type Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { answerChat, chatConfigured } from "./chat.js";
import {
  clearChats,
  deleteChat,
  getChat,
  listChats,
  saveChat,
} from "./chatstore.js";
import {
  HttpError,
  createProject,
  deleteOntology,
  deleteProject,
  getOntology,
  getResult,
  importOntology,
  listOntologies,
  listProjects,
  ontologyPath,
  renameOntology,
  requireProject,
  seedDefaultProject,
  setDeps,
  updateProject,
} from "./projects.js";
import { filterGraph, getReference, hasReference, runSparql } from "./ontology.js";
import {
  compareToReference,
  contextIndex,
  forgetOntologyCaches,
  mapToReference,
  mappedFilePath,
  ontologyGraph,
  sssomFilePath,
} from "./workspace.js";
import { buildSplit } from "./split.js";

const PORT = Number(process.env.DR_BACKEND_PORT ?? 3178);

const app = express();
app.use(cors());
app.use(express.json({ limit: "48mb" }));

/* --- Enveloppe d'erreurs : HttpError → son code, le reste → 500 ------ */
function handle(res: Response, fn: () => unknown): void {
  try {
    const out = fn();
    if (out instanceof Promise) {
      out.then((v) => res.json(v)).catch((e) => fail(res, e));
    } else {
      res.json(out);
    }
  } catch (e) {
    fail(res, e);
  }
}

function fail(res: Response, e: unknown): void {
  const status = e instanceof HttpError ? e.status : 500;
  const error = e instanceof Error ? e.message : String(e);
  if (status >= 500) console.error("[server]", error);
  res.status(status).json({ error });
}

const projectId = (req: Request): string => req.params.pid;

/* --- Santé ---------------------------------------------------------- */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, chat: chatConfigured() });
});

/* ------------------------------ Projets ----------------------------- */

app.get("/api/projects", (_req, res) => {
  handle(res, () => listProjects());
});

app.post("/api/projects", (req, res) => {
  handle(res, () => {
    const { id, name, description } = req.body ?? {};
    if (typeof name !== "string") throw new HttpError(400, "name is required");
    return createProject(
      typeof id === "string" && id ? id : randomUUID(),
      name,
      typeof description === "string" ? description : ""
    );
  });
});

app.get("/api/projects/:pid", (req, res) => {
  handle(res, () => requireProject(projectId(req)));
});

app.patch("/api/projects/:pid", (req, res) => {
  handle(res, () => {
    const { name, description, referenceId } = req.body ?? {};
    return updateProject(projectId(req), {
      name: typeof name === "string" ? name : undefined,
      description: typeof description === "string" ? description : undefined,
      referenceId:
        referenceId === null
          ? null
          : typeof referenceId === "string"
            ? referenceId
            : undefined,
    });
  });
});

app.delete("/api/projects/:pid", (req, res) => {
  handle(res, () => ({ ok: deleteProject(projectId(req)) }));
});

/* --- Référence du projet : métadonnées, graphe, SPARQL, fichiers ----- */

app.get("/api/projects/:pid/meta", (req, res) => {
  handle(res, () => getReference(projectId(req)).meta);
});

app.get("/api/projects/:pid/graph", (req, res) => {
  handle(res, () => {
    const parseSet = (v: unknown): Set<string> | undefined =>
      typeof v === "string" && v ? new Set(v.split(",").filter(Boolean)) : undefined;
    return filterGraph(getReference(projectId(req)), {
      modules: parseSet(req.query.modules),
      lobes: parseSet(req.query.lobes),
      edges: parseSet(req.query.edges),
    });
  });
});

app.post("/api/projects/:pid/sparql", (req, res) => {
  handle(res, () => {
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query.trim()) throw new HttpError(400, "Empty SPARQL query");
    const ref = getReference(projectId(req));
    const t0 = Date.now();
    try {
      // Les préfixes de la référence sont préfixés d'office ; une
      // redéclaration par l'utilisateur reste prioritaire (elle vient après).
      const result = runSparql(ref, ref.prefixHeader + "\n" + query);
      return { ...(result as object), tookMs: Date.now() - t0 };
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
  });
});

app.post("/api/projects/:pid/split/export", (req, res) => {
  try {
    const ref = getReference(projectId(req));
    const { filename, ttl } = buildSplit(ref, req.body ?? {});
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.type("text/turtle").send(ttl);
  } catch (e) {
    fail(res, e instanceof HttpError ? e : new HttpError(400, String(e)));
  }
});

/* ------------------- Ontologies d'un projet ------------------------- */

app.get("/api/projects/:pid/ontologies", (req, res) => {
  handle(res, () => listOntologies(projectId(req)));
});

app.post("/api/projects/:pid/ontologies", (req, res) => {
  handle(res, () => {
    const { id, name, content, deps } = req.body ?? {};
    if (typeof name !== "string" || typeof content !== "string")
      throw new HttpError(400, "name and content are required");
    return importOntology(
      projectId(req),
      typeof id === "string" && id ? id : randomUUID(),
      name,
      content,
      { deps: Array.isArray(deps) ? deps.filter((d) => typeof d === "string") : [] }
    );
  });
});

/** Ontologie appartenant bien au projet de l'URL. */
function ontologyOf(req: Request): string {
  const id = req.params.oid;
  const onto = getOntology(id);
  if (!onto || onto.projectId !== projectId(req))
    throw new HttpError(404, "Unknown ontology in this project");
  return id;
}

app.patch("/api/projects/:pid/ontologies/:oid", (req, res) => {
  handle(res, () => {
    const id = ontologyOf(req);
    const { deps, name } = req.body ?? {};
    let out = getOntology(id)!;
    if (typeof name === "string") out = renameOntology(id, name);
    if (Array.isArray(deps))
      out = setDeps(id, deps.filter((d): d is string => typeof d === "string"));
    return out;
  });
});

app.delete("/api/projects/:pid/ontologies/:oid", (req, res) => {
  handle(res, () => {
    const id = ontologyOf(req);
    const ok = deleteOntology(id);
    forgetOntologyCaches(id);
    return { ok };
  });
});

app.get("/api/projects/:pid/ontologies/:oid/results", (req, res) => {
  handle(res, () => {
    const id = ontologyOf(req);
    return { compare: getResult(id, "compare"), mapping: getResult(id, "mapping") };
  });
});

app.post("/api/projects/:pid/ontologies/:oid/compare", (req, res) => {
  handle(res, () => compareToReference(projectId(req), ontologyOf(req)));
});

app.post("/api/projects/:pid/ontologies/:oid/map", (req, res) => {
  handle(res, () => mapToReference(projectId(req), ontologyOf(req)));
});

app.get("/api/projects/:pid/ontologies/:oid/graph", (req, res) => {
  handle(res, () =>
    ontologyGraph(
      projectId(req),
      ontologyOf(req),
      req.query.version === "mapped" ? "mapped" : "original"
    )
  );
});

app.get("/api/projects/:pid/ontologies/:oid/source", (req, res) => {
  try {
    const id = ontologyOf(req);
    const path = ontologyPath(id);
    if (!path) throw new HttpError(404, "Missing source file");
    res.type("text/turtle").download(path, getOntology(id)!.name);
  } catch (e) {
    fail(res, e);
  }
});

app.get("/api/projects/:pid/ontologies/:oid/mapped.ttl", (req, res) => {
  try {
    const path = mappedFilePath(ontologyOf(req));
    if (!path) throw new HttpError(404, "No mapping generated yet");
    res.type("text/turtle").download(path, "mapped-to-reference.ttl");
  } catch (e) {
    fail(res, e);
  }
});

app.get("/api/projects/:pid/ontologies/:oid/mappings.sssom.tsv", (req, res) => {
  try {
    const path = sssomFilePath(ontologyOf(req));
    if (!path) throw new HttpError(404, "No mapping generated yet");
    res.type("text/tab-separated-values").download(path, "mappings.sssom.tsv");
  } catch (e) {
    fail(res, e);
  }
});

/* --------------------------- Chatbot -------------------------------- */

const chatContextOf = async (pid: string, body: unknown) => {
  const ids = (body as { context?: { ontologies?: unknown } })?.context?.ontologies;
  return Array.isArray(ids)
    ? contextIndex(pid, ids.filter((x): x is string => typeof x === "string"))
    : null;
};

app.post("/api/projects/:pid/chat", async (req, res) => {
  const pid = projectId(req);
  try {
    getReference(pid); // 409 explicite si le projet n'a pas de référence
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const extra = await chatContextOf(pid, req.body);
    res.json(await answerChat(pid, messages, undefined, extra));
  } catch (e) {
    fail(res, e instanceof HttpError ? e : new HttpError(502, String(e)));
  }
});

app.post("/api/projects/:pid/chat/stream", async (req, res) => {
  const pid = projectId(req);
  try {
    getReference(pid);
  } catch (e) {
    fail(res, e);
    return;
  }
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const emit = (ev: Record<string, unknown>) => {
    res.write(JSON.stringify(ev) + "\n");
  };
  try {
    const extra = await chatContextOf(pid, req.body);
    const out = await answerChat(pid, messages, emit, extra);
    emit({ type: "answer", ...out });
  } catch (e) {
    emit({ type: "error", error: e instanceof Error ? e.message : String(e) });
  }
  res.end();
});

/* ------------- Historique des conversations du projet ---------------- */

app.get("/api/projects/:pid/chats", (req, res) => {
  handle(res, () => {
    requireProject(projectId(req));
    return listChats(projectId(req));
  });
});

app.get("/api/projects/:pid/chats/:cid", (req, res) => {
  handle(res, () => {
    const chat = getChat(req.params.cid);
    if (!chat || chat.projectId !== projectId(req))
      throw new HttpError(404, "Unknown conversation");
    return chat;
  });
});

app.put("/api/projects/:pid/chats/:cid", (req, res) => {
  handle(res, () => {
    requireProject(projectId(req));
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!messages) throw new HttpError(400, "messages[] required");
    const saved = saveChat(req.params.cid, projectId(req), messages);
    if (!saved) throw new HttpError(400, "Invalid conversation id");
    return { ok: true, id: saved.id, title: saved.title };
  });
});

app.delete("/api/projects/:pid/chats/:cid", (req, res) => {
  handle(res, () => {
    const chat = getChat(req.params.cid);
    if (!chat || chat.projectId !== projectId(req))
      throw new HttpError(404, "Unknown conversation");
    return { ok: deleteChat(req.params.cid) };
  });
});

app.delete("/api/projects/:pid/chats", (req, res) => {
  handle(res, () => {
    requireProject(projectId(req));
    return { ok: true, deleted: clearChats(projectId(req)) };
  });
});

/* --- Démarrage ------------------------------------------------------- */
console.log("[server] initialisation des projets…");
seedDefaultProject();
app.listen(PORT, () => {
  console.log(`[server] backend Ontology Explorer sur http://localhost:${PORT}`);
  // Pré-chauffage : la référence du premier projet est construite tout de
  // suite pour que le premier affichage du graphe soit immédiat.
  const first = listProjects().find((p) => p.referenceId !== null);
  if (first && hasReference(first.id)) {
    setTimeout(() => {
      try {
        getReference(first.id);
      } catch (e) {
        console.warn(`[server] pré-chargement impossible: ${(e as Error).message}`);
      }
    }, 0);
  }
});
