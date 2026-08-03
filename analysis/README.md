# Ontology Explorer

Exploration, alignement et interrogation d'ontologies OWL/RDF, organisés
**par projet**.

> **Un projet = une ontologie de référence.** On crée un projet, on y importe
> des ontologies, on en désigne **une** comme référence (avec ses éventuelles
> dépendances) : le graphe, SPARQL, le mapping et le chatbot travaillent alors
> tous contre cette référence. Sans référence, ces fonctions sont désactivées.
>
> Au premier démarrage, le **Digital Reference** du dépôt
> (`../DigitalReference.ttl` + `../dependencies/*.ttl`) est importé
> automatiquement comme projet « Digital Reference ».

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
│       ├── rdf.ts        primitives RDF partagées (chargement, classes, préfixes)
│       ├── projects.ts   projets, ontologies importées, dépendances, amorçage
│       ├── ontology.ts   construction du graphe de la RÉFÉRENCE d'un projet
│       ├── chat.ts       moteur GraphRAG (index par projet)
│       ├── workspace.ts  comparaison et mapping vers la référence du projet
│       ├── similarity.ts métriques multi-facettes (module pur)
│       ├── split.ts      export Turtle autonome d'un sous-ensemble
│       ├── chatstore.ts  SQLite (conversations, rattachées à leur projet)
│       └── server.ts     routes REST
├── frontend/         Vite + React (TSX) — visualisation force-directed
│   └── src/
│       ├── App.tsx              sélecteur de projet + navigation
│       ├── tabs/GraphTab.tsx    graphe de la référence + couches importées
│       ├── tabs/ChatTab.tsx     chatbot GraphRAG (conversations du projet)
│       └── tabs/WorkspaceTab.tsx projets, imports, référence, dépendances
├── .data/            SQLite + fichiers des ontologies importées (généré)
├── .cache/           embeddings des fiches, par ontologie de référence (généré)
└── start.sh          launcher (opens a terminal window; closing it stops the app)
```

## Backend API

Tout est relatif à un projet (`:pid`). Les routes qui exigent une référence
répondent **409** avec un message explicite tant que le projet n'en a pas.

| Endpoint | Description |
|---|---|
| `GET /api/health` | liveness probe (+ `chat: true/false` selon la clé API) |
| `GET/POST /api/projects` | liste / création d'un projet |
| `PATCH/DELETE /api/projects/:pid` | renommer, **désigner la référence** (`referenceId`), supprimer |
| `GET /api/projects/:pid/meta` | métadonnées de la référence : modules, groupes, préfixes, fichiers |
| `GET /api/projects/:pid/graph?lobes=…&modules=…&edges=…` | sous-graphe filtré (classes + arêtes) |
| `POST /api/projects/:pid/sparql` `{query}` | SELECT / ASK / CONSTRUCT / DESCRIBE (lecture seule) |
| `POST /api/projects/:pid/split/export` | export Turtle autonome d'un sous-ensemble |
| `GET/POST /api/projects/:pid/ontologies` | ontologies du projet / import (`{name, content, deps}`) |
| `PATCH/DELETE /api/projects/:pid/ontologies/:oid` | **dépendances** (`{deps}`), renommage, suppression |
| `POST …/ontologies/:oid/compare` \| `…/map` | similarité multi-facettes \| alignement vérifié par LLM |
| `GET …/ontologies/:oid/graph?version=original\|mapped` | graphe de l'ontologie importée (couche du Graph) |
| `GET …/ontologies/:oid/source` \| `mapped.ttl` \| `mappings.sssom.tsv` | téléchargements |
| `POST /api/projects/:pid/chat` \| `…/chat/stream` | chatbot GraphRAG (NDJSON pour la trace) |
| `GET/PUT/DELETE /api/projects/:pid/chats[/:cid]` | conversations du projet |

## Frontend

Le **sélecteur de projet** est en haut à gauche : il pilote les trois onglets.

- **Workspace** — tous les **projets** (colonne de gauche). Dans un projet :
  import d'ontologies (.ttl, .rdf, .owl, .nt), désignation de la
  **référence** (★), choix de ses **dépendances** (cases à cocher, chargées
  avec elle comme SOSA/SSN/Time pour le Digital Reference), puis
  **Compare** (similarité lexicale / structurelle / sémantique) et
  **Map to reference** (alignement SKOS vérifié par LLM, réifié SSSOM,
  exportable en Turtle et en TSV). La référence n'est jamais modifiée.
  Les ontologies qui **composent** la référence (elle-même et ses
  dépendances, marquées ⛓) ne sont ni comparables ni mappables : elles sont
  déjà dedans. Dès la première comparaison ou le premier mapping, la
  référence est **figée** (🔒) : on ne peut plus la changer, modifier ses
  dépendances ni les supprimer — tous les résultats pointent vers ses IRIs.
  Supprimer les ontologies alignées (leurs résultats partent avec) dégèle le
  projet.
- **Graph** — rendu force-directed façon WebVOWL de la référence : couleurs
  par **groupe de haut niveau** (les 15 *lobes* du Digital Reference, ou les
  racines de hiérarchie pour une ontologie qui ne suit pas cette convention)
  ou par **module** (namespace), vue 3D navigable façon Blender, 2D
  disponible, nœuds et arêtes cliquables, recherche, épinglage, export
  **Split**. Les autres ontologies du projet s'ajoutent en **couches**
  (`off` / `raw` / `linked`).
- **ChatBot** — GraphRAG groundé sur la référence du projet : condensation
  de la question, retrieval hybride (embeddings + lexical), routage
  *lookup* / *structural* (SPARQL auto-corrigé) / *graph* (algorithmes),
  réponse citée et diagrammes. Les ontologies mappées du projet peuvent être
  ajoutées au contexte. Les conversations sont celles du projet.

## Configuration

Le chatbot et le mapping utilisent OpenRouter : copier `.env.example` en
`.env` et y mettre `OPENROUTER_API_KEY` (voir les modèles surchargeables).
Sans clé, le chatbot répond par une recherche lexicale de démonstration.
