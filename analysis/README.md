# Digital Reference Explorer

Visualization and exploration of the **Digital Reference** ontology
(`../DigitalReference.ttl` + its SOSA/SSN/Time dependencies).

## Getting started

```bash
./start.sh
```

The script opens a dedicated **terminal window** and, inside it:

1. frees the required ports (kills anything still listening on them);
2. locates Node.js (or explains how to install it without root privileges);
3. installs any missing npm dependencies (with clear diagnostics on
   failure: permissions, network/proxy, disk full);
4. starts the **backend** in the background (port `3178`, log in
   `.logs/backend.log`);
5. starts the **frontend** with Vite (port `5173`) and opens the browser.

**Closing that terminal window stops everything** (frontend **and**
backend); `Ctrl+C` inside it does the same. Without a graphical session,
the app runs in the current terminal instead. Custom ports:
`DR_BACKEND_PORT=… DR_FRONTEND_PORT=… ./start.sh`.

## Architecture

```
analysis/
├── backend/          Node + tsx (TypeScript) — Express + oxigraph (in-memory SPARQL)
│   └── src/
│       ├── ontology.ts   TTL loading, class/property graph, lobes, SPARQL, chat stub
│       └── server.ts     REST endpoints
├── frontend/         Vite + React (TSX) — force-directed canvas visualization
│   └── src/
│       ├── tabs/GraphTab.tsx    Graph tab (WebVOWL-like, 3D/2D)
│       ├── tabs/SparqlTab.tsx   SPARQL tab (list + graph views + exports)
│       ├── tabs/ChatTab.tsx     ChatBot tab (UI only, GraphRAG to be plugged in)
│       └── components/          shared 2D/3D force-graph renderers
├── start.sh          launcher (opens a terminal window; closing it stops the app)
└── .logs/            logs and PID files (generated)
```

## Backend API

| Endpoint | Description |
|---|---|
| `GET /api/health` | liveness probe |
| `GET /api/meta` | metadata: ontology info, modules (namespaces), **lobes**, prefixes, files |
| `GET /api/graph?lobes=…&modules=…&edges=subclass,property` | filtered subgraph (classes + edges) |
| `GET /api/files` / `GET /api/files/<name>` | list and download the source TTL files |
| `POST /api/sparql` `{query}` | SELECT / ASK / CONSTRUCT / DESCRIBE (read-only, oxigraph engine) |
| `POST /api/chat` `{messages}` | chatbot **stub** — to be replaced by the GraphRAG engine |

## Frontend tabs

- **Graph** — WebVOWL-like force-directed rendering: classes colored by
  **lobe** (the 15 official Digital Reference lobes, computed through the
  `subClassOf*` closure) or by **module** (`ecsel-dr-*` namespace),
  checkboxes to select which lobes are displayed (instant visibility
  toggling — node positions are preserved), `subClassOf` edges (dashed) and
  object properties (labels on zoom), clickable nodes AND edges with a
  details panel (definition, attributes, navigable relations), search, TTL
  downloads. Default **3D view** with Blender-style navigation (right/middle
  click to rotate around the selection, left click to pan, clickable axis
  gizmo), 2D view available, gentle perpetual motion, elastic node dragging.
- **SPARQL** — editor (Ctrl+Enter), sample queries, results as a **list**
  (paginated table, row selection) or as a **graph**, export to
  CSV / TSV / JSON / Turtle (of the selection or the whole result set).
- **ChatBot** — complete interface (suggestions, markdown, typing
  indicator). The backend currently answers through a demo lexical search:
  plug the future GraphRAG engine into `backend/src/ontology.ts`
  (`chatStub`) or directly behind `POST /api/chat`.

## Plugging in GraphRAG later

The contract is minimal: `POST /api/chat` receives
`{messages: [{role: "user"|"assistant", content: string}]}` and returns
`{reply: string}` (markdown). Replace the `chatStub` implementation —
the frontend does not need to change.
