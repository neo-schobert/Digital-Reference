# Digital Reference Explorer

Visualisation et exploration de l'ontologie **Digital Reference**
(`../DigitalReference.ttl` + ses dépendances SOSA/SSN/Time).

## Lancement

```bash
./start.sh
```

Le script :

1. localise Node.js (ou explique comment l'installer sans droits root) ;
2. installe les dépendances npm manquantes (avec diagnostic clair en cas
   d'échec : permissions, réseau/proxy, disque plein) ;
3. démarre le **backend** en arrière-plan (port `3178`, log dans
   `.logs/backend.log`) ;
4. démarre le **frontend** Vite (port `5173`) et ouvre le navigateur.

`Ctrl+C` arrête le frontend **et** le backend. Pour tout arrêter à la main :
`./stop.sh`. Ports personnalisables : `DR_BACKEND_PORT=… DR_FRONTEND_PORT=… ./start.sh`.

## Architecture

```
analysis/
├── backend/          Node + tsx (TypeScript) — Express + oxigraph (SPARQL en mémoire)
│   └── src/
│       ├── ontology.ts   chargement TTL, graphe classes/propriétés, lobes, SPARQL, stub chat
│       └── server.ts     endpoints REST
├── frontend/         Vite + React (TSX) — visualisation force-directed sur canvas
│   └── src/
│       ├── tabs/GraphTab.tsx    onglet Graphe (WebVOWL-like)
│       ├── tabs/SparqlTab.tsx   onglet SPARQL (liste + graphe + exports)
│       ├── tabs/ChatTab.tsx     onglet ChatBot (interface, GraphRAG à brancher)
│       └── components/NetworkCanvas.tsx  rendu force-graph partagé
├── start.sh / stop.sh
└── .logs/            journaux et PID (générés)
```

## API du backend

| Endpoint | Description |
|---|---|
| `GET /api/health` | sonde de vie |
| `GET /api/meta` | métadonnées : ontologie, modules (namespaces), **lobes**, préfixes, fichiers |
| `GET /api/graph?lobes=…&modules=…&edges=subclass,property` | sous-graphe filtré (classes + arêtes) |
| `GET /api/files` / `GET /api/files/<nom>` | liste et téléchargement des fichiers TTL sources |
| `POST /api/sparql` `{query}` | SELECT / ASK / CONSTRUCT / DESCRIBE (lecture seule, moteur oxigraph) |
| `POST /api/chat` `{messages}` | **stub** du chatbot — à remplacer par le moteur GraphRAG |

## Onglets du frontend

- **Graphe** — rendu force-directed type WebVOWL : classes colorées par
  **lobe** (les 15 lobes officiels du Digital Reference, calculés par
  fermeture `subClassOf*`) ou par **module** (namespace `ecsel-dr-*`),
  cases à cocher pour sélectionner les lobes affichés, arêtes `subClassOf`
  (pointillés) et object properties (labels au zoom), recherche, panneau de
  détails (commentaire, attributs, relations), téléchargement des TTL.
- **SPARQL** — éditeur (Ctrl+Entrée), requêtes d'exemple, résultats en
  **liste** (tableau paginé, sélection de lignes) ou en **graphe**, export
  CSV / TSV / JSON / Turtle (de la sélection ou de tout le résultat).
- **ChatBot** — interface complète (suggestions, markdown, indicateur de
  frappe). Le backend répond via une recherche lexicale de démonstration :
  brancher le futur moteur GraphRAG dans `backend/src/ontology.ts`
  (`chatStub`) ou directement sur `POST /api/chat`.

## Brancher le GraphRAG plus tard

Le contrat est minimal : `POST /api/chat` reçoit
`{messages: [{role: "user"|"assistant", content: string}]}` et renvoie
`{reply: string}` (markdown). Remplacer l'implémentation de `chatStub` —
le frontend n'a pas besoin de changer.
