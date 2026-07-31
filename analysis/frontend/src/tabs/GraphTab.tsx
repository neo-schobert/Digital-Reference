import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  consumeGraphFocus,
  onGraphFocus,
  stashGraphFocus,
  type GraphFocusRequest,
} from "../bus";

// Cache module : le graphe complet n'est téléchargé qu'une fois, même si
// l'onglet est démonté/remonté (un seul onglet vit à la fois).
let graphCache: BuiltGraph | null = null;

// Couches d'ontologies importées (Workspace) affichées dans le graphe :
// sélection et graphes conservés entre montages de l'onglet.
type OverlayVersion = "original" | "mapped";
let savedOverlays: Record<string, OverlayVersion> = {};
let savedShowDr = true;
let savedLayersOpen = true;

// Brouillon du mode Split (export structurel) : conservé entre montages.
interface SplitDraft {
  open: boolean;
  collapsed: boolean;
  name: string;
  seeds: string[];
  subclasses: boolean;
  superclasses: boolean;
  hops: number;
  includeExternal: boolean;
}
let savedSplit: SplitDraft = {
  open: false,
  collapsed: false,
  name: "",
  seeds: [],
  subclasses: true,
  superclasses: true,
  hops: 0,
  includeExternal: false,
};
const overlayGraphCache = new Map<string, BuiltGraph>();
import {
  exportSplit,
  fetchGraph,
  fetchWsGraph,
  fileUrl,
  listWsOntologies,
  type WsOntology,
} from "../api";
import { toCurie } from "../curie";
import { buildColorMap, NEUTRAL_DARK, NEUTRAL_LIGHT } from "../palette";
import type { BuiltGraph, GraphLink, GraphNode, Meta } from "../types";
import NetworkCanvas, { NetworkCanvasHandle } from "../components/NetworkCanvas";
import NetworkCanvas3D, { NetworkCanvas3DHandle } from "../components/NetworkCanvas3D";
import { clearPins, savePins, subscribePins, totalPinCount } from "../pinStore";

type GroupMode = "lobes" | "modules";
type ViewMode = "3d" | "2d";

const NO_LOBE = "none";

function linkKey(l: GraphLink): string {
  return `${l.type}|${l.iri ?? ""}|${l.source}|${l.target}`;
}

interface Props {
  meta: Meta;
  dark: boolean;
}

export default function GraphTab({ meta, dark }: Props) {
  const [groupMode, setGroupMode] = useState<GroupMode>("lobes");
  const [viewMode, setViewMode] = useState<ViewMode>("3d");
  const [selectedLobes, setSelectedLobes] = useState<Set<string>>(
    () => new Set([...meta.lobes.map((l) => l.id), NO_LOBE])
  );
  const [selectedModules, setSelectedModules] = useState<Set<string>>(
    () => new Set(meta.modules.filter((m) => !m.external).map((m) => m.id))
  );
  const [showSubclass, setShowSubclass] = useState(true);
  const [showProperties, setShowProperties] = useState(true);
  const [minDegree, setMinDegree] = useState(0);
  const [fullGraph, setFullGraph] = useState<BuiltGraph>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLinkKey, setSelectedLinkKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [wsList, setWsList] = useState<WsOntology[]>([]);
  const [overlays, setOverlays] = useState<Record<string, OverlayVersion>>(
    savedOverlays
  );
  const [showDr, setShowDr] = useState(savedShowDr);
  const [layersOpen, setLayersOpen] = useState(savedLayersOpen);
  const [layersFilter, setLayersFilter] = useState("");
  // Couche « sélectionnée » (clic sur son nom) : tout le reste s'estompe.
  // "__DR__" = le Digital Reference, sinon le nom court d'une ontologie.
  const [focusSource, setFocusSource] = useState<string | null>(null);

  useEffect(() => {
    savedLayersOpen = layersOpen;
  }, [layersOpen]);

  /* ---- Mode Split : brouillon persistant au niveau module ---- */
  const [split, setSplit] = useState<SplitDraft>(savedSplit);
  useEffect(() => {
    savedSplit = split;
  }, [split]);
  const [splitSearch, setSplitSearch] = useState("");
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [overlayGraphs, setOverlayGraphs] = useState<Record<string, BuiltGraph>>(
    {}
  );
  const canvas2dRef = useRef<NetworkCanvasHandle>(null);
  const canvas3dRef = useRef<NetworkCanvas3DHandle>(null);

  // Épinglages : compteur vivant + flash de confirmation du « Save »
  const [pinCount, setPinCount] = useState(() => totalPinCount());
  const [pinsSaved, setPinsSaved] = useState(false);
  useEffect(() => subscribePins(() => setPinCount(totalPinCount())), []);


  /* ---- Chargement UNIQUE du graphe complet : ensuite tout le filtrage est
     local, donc cocher/décocher retire les nœuds en place, sans rechargement */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (graphCache) {
      setFullGraph(graphCache);
      setLoading(false);
      return;
    }
    fetchGraph({})
      .then((g) => {
        graphCache = g;
        if (!cancelled) setFullGraph(g);
      })
      .catch((e) => console.error(e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---- Couches Workspace : liste + graphes des versions actives ---- */
  useEffect(() => {
    savedOverlays = overlays;
  }, [overlays]);
  useEffect(() => {
    savedShowDr = showDr;
  }, [showDr]);

  useEffect(() => {
    listWsOntologies()
      .then((list) => {
        setWsList(list);
        // purge des sélections d'ontologies supprimées entre-temps
        setOverlays((prev) => {
          const ids = new Set(list.map((o) => o.id));
          const next = Object.fromEntries(
            Object.entries(prev).filter(([id]) => ids.has(id))
          );
          return Object.keys(next).length === Object.keys(prev).length
            ? prev
            : next;
        });
      })
      .catch(() => {});
  }, []);

  // Préchargement de TOUTES les couches (les deux versions) dès que la liste
  // est connue : activer/désactiver une couche ensuite n'est qu'une bascule
  // de visibilité dans le canvas — aucun rechargement, aucune reconstruction.
  useEffect(() => {
    let cancelled = false;
    for (const o of wsList) {
      const versions: OverlayVersion[] = o.hasMapping
        ? ["original", "mapped"]
        : ["original"];
      for (const version of versions) {
        const key = `${o.id}:${version}`;
        const cached = overlayGraphCache.get(key);
        if (cached) {
          setOverlayGraphs((prev) => (prev[key] ? prev : { ...prev, [key]: cached }));
          continue;
        }
        fetchWsGraph(o.id, version)
          .then((g) => {
            overlayGraphCache.set(key, g);
            if (!cancelled) setOverlayGraphs((prev) => ({ ...prev, [key]: g }));
          })
          .catch((e) => console.error(e));
      }
    }
    return () => {
      cancelled = true;
    };
  }, [wsList]);

  /* ---- Graphe combiné : superset stable DR + TOUTES les couches ----
     Il ne change qu'au chargement des données, jamais lors des toggles :
     les canvas gardent donc leurs objets et leurs positions. ---- */
  const combined = useMemo(() => {
    if (wsList.length === 0) return fullGraph;
    const nodes = [...fullGraph.nodes];
    const links = [...fullGraph.links];
    const seenNode = new Set(fullGraph.nodes.map((n) => n.id));
    const seenLink = new Set(fullGraph.links.map(linkKey));
    for (const o of wsList) {
      for (const version of ["original", "mapped"] as const) {
        const g = overlayGraphs[`${o.id}:${version}`];
        if (!g) continue;
        for (const n of g.nodes) {
          if (!seenNode.has(n.id)) {
            seenNode.add(n.id);
            nodes.push(n);
          }
        }
        for (const l of g.links) {
          const k = linkKey(l);
          if (!seenLink.has(k)) {
            seenLink.add(k);
            links.push(l);
          }
        }
      }
    }
    return { nodes, links };
  }, [fullGraph, wsList, overlayGraphs]);

  // Palette stable : toutes les ontologies importées ont leur couleur,
  // qu'elles soient affichées ou non.
  const overlaySources = useMemo(
    () => wsList.map((o) => o.name.replace(/\.[^.]+$/, "")),
    [wsList]
  );

  // Mode d'affichage par nom court (pour la visibilité des nœuds/arêtes)
  const modeBySource = useMemo(() => {
    const m = new Map<string, "off" | OverlayVersion>();
    for (const o of wsList) {
      m.set(o.name.replace(/\.[^.]+$/, ""), overlays[o.id] ?? "off");
    }
    return m;
  }, [wsList, overlays]);

  /* ---- Focus demandé par le chatbot (nœud ou relation mentionnés) ---- */
  useEffect(() => {
    const ensureVisible = (iri: string) => {
      const n = combined.nodes.find((x) => x.id === iri);
      if (!n) return;
      if (n.source) {
        // Nœud d'une ontologie importée : activer sa couche si besoin
        const onto = wsList.find(
          (o) => o.name.replace(/\.[^.]+$/, "") === n.source
        );
        if (onto && !overlays[onto.id]) {
          setOverlays((prev) => ({
            ...prev,
            [onto.id]: onto.hasMapping ? "mapped" : "original",
          }));
        }
        return;
      }
      if (n.degree < minDegree) setMinDegree(0);
      if (groupMode === "lobes") {
        const visible =
          n.lobes.some((l) => selectedLobes.has(l)) ||
          (selectedLobes.has(NO_LOBE) && n.lobes.length === 0);
        if (!visible)
          setSelectedLobes(
            (prev) => new Set([...prev, ...(n.lobes.length ? n.lobes : [NO_LOBE])])
          );
      } else if (!selectedModules.has(n.module)) {
        setSelectedModules((prev) => new Set([...prev, n.module]));
      }
    };
    const apply = (r: GraphFocusRequest) => {
      consumeGraphFocus();
      if (combined.nodes.length === 0) {
        stashGraphFocus(r); // ré-appliquée quand le graphe sera chargé
        return;
      }
      let focusIri: string | null = null;
      if ("iri" in r) {
        ensureVisible(r.iri);
        setSelectedLinkKey(null);
        setSelectedId(r.iri);
        focusIri = r.iri;
      } else {
        const between = combined.links.filter(
          (l) =>
            (l.source === r.from && l.target === r.to) ||
            (l.source === r.to && l.target === r.from)
        );
        const link =
          between.find((l) =>
            r.via === "subClassOf" ? l.type === "subclass" : l.label === r.via
          ) ?? between[0];
        ensureVisible(r.from);
        ensureVisible(r.to);
        if (link) {
          if (!showSubclass && link.type === "subclass") setShowSubclass(true);
          if (!showProperties && link.type === "property") setShowProperties(true);
          setSelectedId(null);
          setSelectedLinkKey(linkKey(link));
          focusIri = link.source;
        } else {
          setSelectedLinkKey(null);
          setSelectedId(r.from);
          focusIri = r.from;
        }
      }
      if (focusIri) {
        const iri = focusIri;
        // Le canvas peut encore être en train de charger/positionner : on
        // réessaie jusqu'à ce que le vol de caméra ait réellement eu lieu.
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          const ok =
            (canvas3dRef.current?.focusNode(iri) ?? false) ||
            (canvas2dRef.current?.focusNode(iri) ?? false);
          if (ok || tries > 25) clearInterval(timer);
        }, 200);
      }
    };
    const pending = consumeGraphFocus();
    if (pending) apply(pending);
    return onGraphFocus(apply);
  }, [combined, wsList, overlays, groupMode, selectedLobes, selectedModules, minDegree, showSubclass, showProperties]);

  const highlightIds = useMemo(() => {
    if (!focusSource) return null;
    return new Set(
      combined.nodes
        .filter((n) =>
          focusSource === "__DR__" ? !n.source : n.source === focusSource
        )
        .map((n) => n.id)
    );
  }, [focusSource, combined]);

  const toggleFocusSource = useCallback((src: string) => {
    setFocusSource((cur) => (cur === src ? null : src));
  }, []);

  /* ---- Mode Split : sous-ensemble structurel exportable ----
     Mêmes règles d'expansion que buildSplit côté backend (split.ts) :
     l'aperçu estompé correspond exactement au fichier exporté.
     Ordre : graines → descendants → N sauts de propriétés → ancêtres. */
  const splitAdj = useMemo(() => {
    const parents = new Map<string, string[]>();
    const children = new Map<string, string[]>();
    const propNb = new Map<string, string[]>();
    const add = (m: Map<string, string[]>, k: string, v: string) => {
      const arr = m.get(k);
      if (arr) arr.push(v);
      else m.set(k, [v]);
    };
    for (const l of fullGraph.links) {
      if (l.type === "subclass") {
        add(parents, l.source, l.target);
        add(children, l.target, l.source);
      } else {
        add(propNb, l.source, l.target);
        add(propNb, l.target, l.source);
      }
    }
    return { parents, children, propNb };
  }, [fullGraph]);

  const splitMembers = useMemo(() => {
    if (!split.open || split.seeds.length === 0) return null;
    const byId = new Map(fullGraph.nodes.map((n) => [n.id, n]));
    const allowed = (id: string) => {
      const n = byId.get(id);
      return n !== undefined && (split.includeExternal || !n.external);
    };
    const members = new Set(split.seeds.filter((id) => byId.has(id)));
    const grow = (adj: Map<string, string[]>) => {
      const stack = [...members];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const nb of adj.get(cur) ?? []) {
          if (!members.has(nb) && allowed(nb)) {
            members.add(nb);
            stack.push(nb);
          }
        }
      }
    };
    if (split.subclasses) grow(splitAdj.children);
    for (let h = 0; h < split.hops; h++) {
      const frontier: string[] = [];
      for (const id of members) {
        for (const nb of splitAdj.propNb.get(id) ?? []) {
          if (!members.has(nb) && allowed(nb)) frontier.push(nb);
        }
      }
      for (const id of frontier) members.add(id);
    }
    if (split.superclasses) grow(splitAdj.parents);
    return members;
  }, [split, fullGraph, splitAdj]);

  const splitLinkCount = useMemo(() => {
    if (!splitMembers) return 0;
    let count = 0;
    for (const l of fullGraph.links) {
      if (splitMembers.has(l.source) && splitMembers.has(l.target)) count++;
    }
    return count;
  }, [splitMembers, fullGraph]);

  // L'aperçu du split prime sur le focus de couche (tout le reste s'estompe).
  const effectiveHighlight = splitMembers ?? highlightIds;

  const toggleSeed = useCallback((id: string) => {
    setSplit((s) => ({
      ...s,
      seeds: s.seeds.includes(id)
        ? s.seeds.filter((x) => x !== id)
        : [...s.seeds, id],
    }));
  }, []);

  const openSplitWith = useCallback((id?: string) => {
    setSplit((s) => ({
      ...s,
      open: true,
      collapsed: false,
      seeds: id && !s.seeds.includes(id) ? [...s.seeds, id] : s.seeds,
    }));
  }, []);

  const splitSearchResults = useMemo(() => {
    const q = splitSearch.trim().toLowerCase();
    if (q.length < 2) return [];
    return fullGraph.nodes
      .filter(
        (n) =>
          !split.seeds.includes(n.id) &&
          (n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
      )
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 8);
  }, [splitSearch, fullGraph, split.seeds]);

  const doExportSplit = useCallback(async () => {
    if (split.seeds.length === 0) return;
    setSplitBusy(true);
    setSplitError(null);
    try {
      const blob = await exportSplit({
        name: split.name,
        seeds: split.seeds,
        subclasses: split.subclasses,
        superclasses: split.superclasses,
        hops: split.hops,
        includeExternal: split.includeExternal,
      });
      const slug =
        split.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "dr-split";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${slug}.ttl`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setSplitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSplitBusy(false);
    }
  }, [split]);

  /* ---- Révélation progressive : le canvas reçoit les nœuds par lots ----
     Le premier lot (les plus connectés = le squelette) s'affiche
     immédiatement, le reste arrive étalé sur les frames : jamais plus de
     ~170 objets three.js créés d'un coup, quel que soit la taille du graphe. */
  const orderedNodes = useMemo(() => {
    const dr = combined.nodes
      .filter((n) => !n.source)
      .sort((a, b) => b.degree - a.degree);
    const imported = combined.nodes.filter((n) => n.source);
    return [...dr, ...imported];
  }, [combined]);

  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    const total = orderedNodes.length;
    setRevealed((r) => Math.min(r, total)); // rétrécit si une couche disparaît
    if (total === 0) return;
    const iv = setInterval(() => {
      setRevealed((r) => {
        if (r >= total) {
          clearInterval(iv);
          return r;
        }
        return Math.min(total, r + (r === 0 ? 400 : 320));
      });
    }, 70);
    return () => clearInterval(iv);
  }, [orderedNodes]);

  const revealedIds = useMemo(
    () => new Set(orderedNodes.slice(0, revealed).map((n) => n.id)),
    [orderedNodes, revealed]
  );

  /* ---- Filtrage client-side (pure visibilité, aucun rechargement) ---- */
  const graph = useMemo(() => {
    const keepNode = (n: GraphNode) => {
      // Les nœuds des couches importées suivent leur sélecteur dédié, pas les
      // filtres lobes/modules/seuil du DR.
      if (n.source) return (modeBySource.get(n.source) ?? "off") !== "off";
      if (!showDr) return false;
      return groupMode === "lobes"
        ? n.lobes.some((l) => selectedLobes.has(l)) ||
            (selectedLobes.has(NO_LOBE) && n.lobes.length === 0)
        : selectedModules.has(n.module);
    };
    const nodes = combined.nodes.filter(
      (n) => keepNode(n) && (n.source ? true : n.degree >= minDegree)
    );
    const kept = new Set(nodes.map((n) => n.id));
    const sourceOf = new Map(
      combined.nodes.filter((n) => n.source).map((n) => [n.id, n.source!])
    );
    const links = combined.links.filter((l) => {
      if (!kept.has(l.source) || !kept.has(l.target)) return false;
      const src = sourceOf.get(l.source);
      if (src) {
        const mode = modeBySource.get(src) ?? "off";
        if (mode === "off") return false;
        // Les axiomes de liaison ne se voient qu'en version « linked »
        if (l.mapping && mode !== "mapped") return false;
      }
      return l.type === "subclass" ? showSubclass : showProperties;
    });
    return { nodes, links };
  }, [combined, modeBySource, groupMode, selectedLobes, selectedModules, showSubclass, showProperties, minDegree, showDr]);

  const maxDegree = useMemo(
    () => Math.min(50, fullGraph.nodes.reduce((m, n) => Math.max(m, n.degree), 0)),
    [fullGraph]
  );

  /* ---- Couleurs par groupe (ordre fixe issu du meta) ---- */
  const lobeOrder = useMemo(() => meta.lobes.map((l) => l.id), [meta]);
  const moduleOrder = useMemo(() => meta.modules.map((m) => m.id), [meta]);
  const colorMap = useMemo(
    () =>
      buildColorMap(
        [...(groupMode === "lobes" ? lobeOrder : moduleOrder), ...overlaySources],
        dark
      ),
    [groupMode, lobeOrder, moduleOrder, dark, overlaySources]
  );
  const neutral = dark ? NEUTRAL_DARK : NEUTRAL_LIGHT;
  const colorOf = useCallback(
    (group: string) => colorMap.get(group) ?? neutral,
    [colorMap, neutral]
  );

  /* ---- Adaptation nœuds/arêtes -> viz ---- */
  const groupOfNode = useCallback(
    (n: GraphNode) => {
      if (n.source) return n.source;
      if (groupMode === "modules") return n.module;
      for (const id of lobeOrder) if (n.lobes.includes(id)) return id;
      return NO_LOBE;
    },
    [groupMode, lobeOrder]
  );

  // Données COMPLÈTES passées une seule fois aux canvas : le filtrage se fait
  // par ensembles de visibilité (aucune reconstruction => pas de lag, et les
  // nœuds décochés disparaissent en place).
  const vizNodes = useMemo(
    () =>
      orderedNodes.slice(0, revealed).map((n) => ({
        id: n.id,
        label: n.label,
        group: groupOfNode(n),
        degree: n.degree,
      })),
    [orderedNodes, revealed, groupOfNode]
  );
  const vizLinks = useMemo(() => {
    const links = combined.links
      .filter((l) => revealedIds.has(l.source) && revealedIds.has(l.target))
      .map((l) => ({
      source: l.source,
      target: l.target,
      kind: l.type,
      label: l.label,
      key: linkKey(l),
      lslot: undefined as number | undefined,
      lflip: false,
      lt: undefined as number | undefined,
    }));
    // Arêtes parallèles (ex. bidirectionnelles) : répartir les labels sur des
    // slots perpendiculaires pour qu'ils ne se chevauchent pas.
    const pairs = new Map<string, number[]>();
    links.forEach((l, i) => {
      const k =
        l.source < l.target
          ? `${l.source}\u0000${l.target}`
          : `${l.target}\u0000${l.source}`;
      if (!pairs.has(k)) pairs.set(k, []);
      pairs.get(k)!.push(i);
    });
    pairs.forEach((idxs) => {
      if (idxs.length < 2) return;
      idxs.forEach((li, j) => {
        const link = links[li];
        link.lslot = j - (idxs.length - 1) / 2;
        link.lflip = link.source > link.target;
        // Répartition LE LONG de l'arête (0.25 → 0.75), en direction
        // canonique de la paire : c'est la vraie garantie anti-chevauchement
        // pour des labels larges.
        const tBase = 0.25 + (0.5 * j) / (idxs.length - 1);
        link.lt = link.lflip ? 1 - tBase : tBase;
      });
    });
    return links;
  }, [combined, revealedIds]);
  const visibleNodeIds = useMemo(
    () => new Set(graph.nodes.map((n) => n.id)),
    [graph]
  );
  const visibleLinkKeys = useMemo(
    () => new Set(graph.links.map(linkKey)),
    [graph]
  );

  const nodeById = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of combined.nodes) m.set(n.id, n);
    return m;
  }, [combined]);

  const selectedNode = selectedId ? (nodeById.get(selectedId) ?? null) : null;
  const selectedLink = useMemo(
    () =>
      selectedLinkKey
        ? (graph.links.find((l) => linkKey(l) === selectedLinkKey) ?? null)
        : null,
    [selectedLinkKey, graph]
  );

  /* ---- Voisins du nœud sélectionné (pour le panneau) ---- */
  const selectedNeighbors = useMemo(() => {
    if (!selectedId) return [];
    const out: { rel: string; dir: "→" | "←"; node: GraphNode }[] = [];
    for (const l of graph.links) {
      if (l.source === selectedId && nodeById.has(l.target)) {
        out.push({ rel: l.label ?? l.type, dir: "→", node: nodeById.get(l.target)! });
      } else if (l.target === selectedId && nodeById.has(l.source)) {
        out.push({ rel: l.label ?? l.type, dir: "←", node: nodeById.get(l.source)! });
      }
    }
    out.sort((a, b) => a.rel.localeCompare(b.rel) || a.node.label.localeCompare(b.node.label));
    return out.slice(0, 80);
  }, [selectedId, graph, nodeById]);

  /* ---- Recherche ---- */
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    return graph.nodes
      .filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 12);
  }, [search, graph]);

  const selectAndFocus = useCallback(
    (id: string) => {
      setSelectedLinkKey(null);
      setSelectedId(id);
      setSearch("");
      // Le nœud peut ne pas encore être révélé (chargement progressif) : on
      // réessaie jusqu'à ce que le vol de caméra ait eu lieu.
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        const ok =
          viewMode === "3d"
            ? (canvas3dRef.current?.focusNode(id) ?? false)
            : (canvas2dRef.current?.focusNode(id) ?? false);
        if (ok || tries > 20) clearInterval(timer);
      }, 150);
    },
    [viewMode]
  );

  /* ---- Groupes affichés dans le panneau ---- */
  const noLobeCount = useMemo(
    () => fullGraph.nodes.filter((n) => n.lobes.length === 0).length,
    [fullGraph]
  );

  const groups =
    groupMode === "lobes"
      ? [
          ...meta.lobes.map((l) => ({
            id: l.id,
            name: l.label,
            count: l.classCount,
            title: l.comment,
          })),
          {
            id: NO_LOBE,
            name: "No lobe",
            count: noLobeCount,
            title: "Classes not attached to any lobe",
          },
        ]
      : meta.modules.map((m) => ({
          id: m.id,
          name: m.id + (m.external ? " (ext.)" : ""),
          count: m.classCount,
          title: m.namespace,
        }));

  const activeSet = groupMode === "lobes" ? selectedLobes : selectedModules;
  const setActiveSet = groupMode === "lobes" ? setSelectedLobes : setSelectedModules;

  const toggleGroup = (id: string) => {
    setActiveSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = useCallback((idOrNull: string | null) => {
    setSelectedId(idOrNull);
  }, []);

  return (
    <div className="graph-layout">
      {/* ------------- Panneau latéral gauche ------------- */}
      <aside className="sidebar">
        <div className="search-box">
          <input
            placeholder="Search for a class…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map((n) => (
                <button key={n.id} onClick={() => selectAndFocus(n.id)}>
                  {n.label}
                  <div className="sub">
                    {toCurie(n.id)} · {n.module}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3>Group by</h3>
          <div className="segmented">
            <button
              className={groupMode === "lobes" ? "active" : ""}
              onClick={() => setGroupMode("lobes")}
            >
              Lobes
            </button>
            <button
              className={groupMode === "modules" ? "active" : ""}
              onClick={() => setGroupMode("modules")}
            >
              Modules
            </button>
          </div>
        </div>

        <div>
          <h3>{groupMode === "lobes" ? "Lobes" : "Modules (namespaces)"}</h3>
          <div className="group-list">
            {groups.map((g) => (
              <label key={g.id} className="group-row" title={g.title ?? undefined}>
                <input
                  type="checkbox"
                  checked={activeSet.has(g.id)}
                  onChange={() => toggleGroup(g.id)}
                />
                <span className="chip" style={{ background: colorOf(g.id) }} />
                <span className="name">{g.name}</span>
                {g.count >= 0 && <span className="count">{g.count}</span>}
              </label>
            ))}
          </div>
          <div className="mini-actions">
            <button onClick={() => setActiveSet(new Set(groups.map((g) => g.id)))}>
              All
            </button>
            <button onClick={() => setActiveSet(new Set())}>None</button>
            {groupMode === "modules" && (
              <button
                onClick={() =>
                  setActiveSet(
                    new Set(meta.modules.filter((m) => !m.external).map((m) => m.id))
                  )
                }
              >
                Internal
              </button>
            )}
          </div>
        </div>

        <div>
          <h3>Edges</h3>
          <label className="check-row">
            <input
              type="checkbox"
              checked={showSubclass}
              onChange={(e) => setShowSubclass(e.target.checked)}
            />
            Hierarchy (subClassOf)
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={showProperties}
              onChange={(e) => setShowProperties(e.target.checked)}
            />
            Object properties
          </label>
        </div>

        <div className="sidebar-footer">
          <div>
            <strong>{meta.ontology.title}</strong> v{meta.ontology.version} ·{" "}
            {meta.ontology.triples.toLocaleString("en-US")} triples
          </div>
          <div style={{ marginTop: 6 }}>
            {meta.files.map((f) => (
              <div key={f.name}>
                <a href={fileUrl(f.name)} download>
                  ⬇ {f.name}
                </a>{" "}
                <span style={{ color: "var(--text-muted)" }}>
                  ({Math.round(f.size / 1024).toLocaleString("en-US")} KB)
                </span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* ------------- Zone graphe ------------- */}
      <div className="graph-main">
        {loading && <div className="loading-overlay">Loading graph…</div>}
        <div className="graph-status">
          {graph.nodes.length.toLocaleString("en-US")} classes ·{" "}
          {graph.links.length.toLocaleString("en-US")} links
          {revealed < orderedNodes.length && (
            <span className="reveal-progress">
              {" "}
              · loading {Math.round((100 * revealed) / orderedNodes.length)}%
            </span>
          )}
          {selectedNode ? ` — selected: ${selectedNode.label}` : ""}
          {selectedLink ? ` — edge: ${selectedLink.label ?? selectedLink.type}` : ""}
        </div>
        {viewMode === "3d" ? (
          <NetworkCanvas3D
            ref={canvas3dRef}
            nodes={vizNodes}
            links={vizLinks}
            colorOf={colorOf}
            dark={dark}
            selectedId={selectedId}
            selectedLinkKey={selectedLinkKey}
            onSelect={clearSelection}
            onSelectLink={setSelectedLinkKey}
            visibleNodeIds={visibleNodeIds}
            visibleLinkKeys={visibleLinkKeys}
            highlightIds={effectiveHighlight}
          />
        ) : (
          <NetworkCanvas
            ref={canvas2dRef}
            nodes={vizNodes}
            links={vizLinks}
            colorOf={colorOf}
            dark={dark}
            selectedId={selectedId}
            selectedLinkKey={selectedLinkKey}
            onSelect={clearSelection}
            onSelectLink={setSelectedLinkKey}
            visibleNodeIds={visibleNodeIds}
            visibleLinkKeys={visibleLinkKeys}
            highlightIds={effectiveHighlight}
          />
        )}
        <div className="layers-box" title="Choose which ontologies are shown">
          <button
            className="layers-title layers-toggle"
            onClick={() => setLayersOpen((v) => !v)}
            title={layersOpen ? "Collapse" : "Expand"}
          >
            {layersOpen ? "▾" : "▸"} Ontologies
            {wsList.length > 0 && ` (${wsList.length + 1})`}
            {!layersOpen &&
              Object.keys(overlays).length > 0 &&
              ` · ${Object.keys(overlays).length} shown`}
          </button>
          {layersOpen && (
          <div className="layers-body">
          <div className="layers-row">
            <input
              type="checkbox"
              checked={showDr}
              onChange={(e) => {
                setShowDr(e.target.checked);
                if (!e.target.checked && focusSource === "__DR__")
                  setFocusSource(null);
              }}
            />
            <span
              className={`layers-name clickable${focusSource === "__DR__" ? " focused" : ""}`}
              title="Click to highlight the Digital Reference (dims everything else)"
              onClick={() => {
                if (!showDr) setShowDr(true);
                toggleFocusSource("__DR__");
              }}
            >
              Digital Reference
            </span>
          </div>
          {wsList.length > 6 && (
            <input
              className="layers-filter"
              placeholder="Filter ontologies…"
              value={layersFilter}
              onChange={(e) => setLayersFilter(e.target.value)}
            />
          )}
          {wsList
            .filter(
              (o) =>
                !layersFilter ||
                o.name.toLowerCase().includes(layersFilter.toLowerCase())
            )
            .map((o) => {
            const short = o.name.replace(/\.[^.]+$/, "");
            // Record<string, V> type l'accès indexé sans undefined : assertion
            const mode = (overlays[o.id] ?? "off") as OverlayVersion | "off";
            const setMode = (m: "off" | OverlayVersion) => {
              setOverlays((prev) => {
                const next = { ...prev };
                if (m === "off") delete next[o.id];
                else next[o.id] = m;
                return next;
              });
              if (m === "off" && focusSource === short) setFocusSource(null);
            };
            return (
              <div className="layers-row" key={o.id}>
                <span
                  className="chip"
                  style={{
                    background:
                      mode === "off" ? "var(--surface-3)" : colorOf(short),
                  }}
                />
                <span
                  className={`layers-name clickable${focusSource === short ? " focused" : ""}`}
                  title={`${o.name} — click to highlight this ontology (dims everything else)`}
                  onClick={() => {
                    if (mode === "off")
                      setMode(o.hasMapping ? "mapped" : "original");
                    toggleFocusSource(short);
                  }}
                >
                  {short}
                </span>
                <span className="layers-seg">
                  <button
                    className={mode === "off" ? "active" : ""}
                    onClick={() => setMode("off")}
                  >
                    off
                  </button>
                  <button
                    className={mode === "original" ? "active" : ""}
                    title="Show the imported ontology as-is (disconnected from the DR)"
                    onClick={() => setMode("original")}
                  >
                    raw
                  </button>
                  <button
                    className={mode === "mapped" ? "active" : ""}
                    disabled={!o.hasMapping}
                    title={
                      o.hasMapping
                        ? "Show the DR-linked version (mapping axioms as edges)"
                        : "Run “Map to DR” in the Workspace tab first"
                    }
                    onClick={() => setMode("mapped")}
                  >
                    linked
                  </button>
                </span>
              </div>
            );
            })}
          </div>
          )}
        </div>
        {!split.open && (
          <button
            className="split-launch"
            title="Extract a subset of the ontology as a standalone Turtle file"
            onClick={() => openSplitWith()}
          >
            ✂ Split
          </button>
        )}
        {split.open && (
          <div className="split-box">
            <div className="split-head">
              <button
                className="layers-title layers-toggle"
                onClick={() => setSplit((s) => ({ ...s, collapsed: !s.collapsed }))}
                title={split.collapsed ? "Expand" : "Collapse"}
              >
                {split.collapsed ? "▸" : "▾"} ✂ Split
                {splitMembers && ` · ${splitMembers.size} classes`}
              </button>
              <button
                className="split-close"
                title="Exit split mode (the draft is kept)"
                onClick={() => setSplit((s) => ({ ...s, open: false }))}
              >
                ✕
              </button>
            </div>
            {!split.collapsed && (
              <div className="split-body">
                <input
                  className="layers-filter"
                  placeholder="Split name (file name)…"
                  value={split.name}
                  onChange={(e) =>
                    setSplit((s) => ({ ...s, name: e.target.value }))
                  }
                />
                <div className="split-section">Seed classes</div>
                {split.seeds.length === 0 && (
                  <div className="split-hint">
                    Select a class in the graph and use “＋ Add to split”, or
                    search below. Everything staying lit will be exported.
                  </div>
                )}
                {split.seeds.length > 0 && (
                  <div className="split-chips">
                    {split.seeds.map((id) => (
                      <span key={id} className="split-chip" title={id}>
                        {nodeById.get(id)?.label ?? id}
                        <button
                          onClick={() => toggleSeed(id)}
                          title="Remove this seed"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <input
                  className="layers-filter"
                  placeholder="Add a class…"
                  value={splitSearch}
                  onChange={(e) => setSplitSearch(e.target.value)}
                />
                {splitSearchResults.length > 0 && (
                  <div className="split-results">
                    {splitSearchResults.map((n) => (
                      <button
                        key={n.id}
                        title={n.id}
                        onClick={() => {
                          toggleSeed(n.id);
                          setSplitSearch("");
                        }}
                      >
                        ＋ {n.label} <span className="sub">{n.module}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="split-section">Expansion</div>
                <label
                  className="check-row"
                  title="Include the whole subClassOf descent of the seeds"
                >
                  <input
                    type="checkbox"
                    checked={split.subclasses}
                    onChange={(e) =>
                      setSplit((s) => ({ ...s, subclasses: e.target.checked }))
                    }
                  />
                  Subclasses (descendants)
                </label>
                <label
                  className="check-row"
                  title="Include the parent chain up to the root (keeps the module understandable)"
                >
                  <input
                    type="checkbox"
                    checked={split.superclasses}
                    onChange={(e) =>
                      setSplit((s) => ({ ...s, superclasses: e.target.checked }))
                    }
                  />
                  Superclasses (context)
                </label>
                <div
                  className="split-hops"
                  title="Also include classes reachable through object properties"
                >
                  <span>Via properties</span>
                  <span className="layers-seg">
                    {[0, 1, 2].map((h) => (
                      <button
                        key={h}
                        className={split.hops === h ? "active" : ""}
                        onClick={() => setSplit((s) => ({ ...s, hops: h }))}
                      >
                        {h === 0 ? "off" : `${h} hop${h > 1 ? "s" : ""}`}
                      </button>
                    ))}
                  </span>
                </div>
                <label
                  className="check-row"
                  title="Allow external classes (SOSA, Schema.org…) in the expansion"
                >
                  <input
                    type="checkbox"
                    checked={split.includeExternal}
                    onChange={(e) =>
                      setSplit((s) => ({
                        ...s,
                        includeExternal: e.target.checked,
                      }))
                    }
                  />
                  Include external classes
                </label>
                <div className="split-footer">
                  <span className="split-count">
                    {splitMembers
                      ? `${splitMembers.size.toLocaleString("en-US")} classes · ${splitLinkCount.toLocaleString("en-US")} links`
                      : "no seeds yet"}
                  </span>
                  <button
                    className="split-export"
                    disabled={splitBusy || split.seeds.length === 0}
                    title="Download the subset as a standalone .ttl (works offline, re-importable in the Workspace)"
                    onClick={() => void doExportSplit()}
                  >
                    {splitBusy ? "Exporting…" : "⬇ Export .ttl"}
                  </button>
                </div>
                {splitError && <div className="split-error">⚠️ {splitError}</div>}
              </div>
            )}
          </div>
        )}
        <div className="view-switch" role="tablist" aria-label="View mode">
          <button
            role="tab"
            aria-selected={viewMode === "3d"}
            className={viewMode === "3d" ? "active" : ""}
            onClick={() => setViewMode("3d")}
          >
            3D
          </button>
          <button
            role="tab"
            aria-selected={viewMode === "2d"}
            className={viewMode === "2d" ? "active" : ""}
            onClick={() => setViewMode("2d")}
          >
            2D
          </button>
        </div>
        {pinCount > 0 && (
          <div
            className="pin-box"
            title="Pinned nodes — hold a dragged node still to pin it"
          >
            <span className="pin-count">📌 {pinCount}</span>
            <button
              onClick={() => {
                savePins();
                setPinsSaved(true);
                setTimeout(() => setPinsSaved(false), 1400);
              }}
              title="Keep these pins after a page reload"
            >
              {pinsSaved ? "Saved ✓" : "Save"}
            </button>
            <button
              onClick={() => {
                clearPins();
                canvas2dRef.current?.resetPins();
                canvas3dRef.current?.resetPins();
              }}
              title="Unpin everything (also clears the saved pins)"
            >
              Reset
            </button>
          </div>
        )}
        <div
          className="threshold-box"
          title="Hide nodes with fewer connections than the threshold"
        >
          <span className="thr-label">
            Importance ≥ {minDegree}
            <span className="thr-count">
              {graph.nodes.length.toLocaleString("en-US")} shown
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={maxDegree}
            step={1}
            value={minDegree}
            onChange={(e) => setMinDegree(Number(e.target.value))}
          />
        </div>
      </div>

      {/* ------------- Panneau de détails ------------- */}
      <aside className="details-panel">
        {selectedLink ? (
          <>
            <h2>{selectedLink.label ?? "subClassOf"}</h2>
            {selectedLink.iri && (
              <div className="curie" title={selectedLink.iri}>
                {toCurie(selectedLink.iri)}
              </div>
            )}
            <div className="badge-row">
              <span className="badge">
                {selectedLink.type === "subclass"
                  ? "hierarchy (rdfs:subClassOf)"
                  : "object property"}
              </span>
            </div>
            <h4>Domain → Range</h4>
            <button
              className="neighbor-btn"
              onClick={() => selectAndFocus(selectedLink.source)}
            >
              <span className="neighbor-rel">from </span>
              {nodeById.get(selectedLink.source)?.label ?? selectedLink.source}
            </button>
            <button
              className="neighbor-btn"
              onClick={() => selectAndFocus(selectedLink.target)}
            >
              <span className="neighbor-rel">to </span>
              {nodeById.get(selectedLink.target)?.label ?? selectedLink.target}
            </button>
          </>
        ) : selectedNode ? (
          <>
            <h2>{selectedNode.label}</h2>
            <div className="curie" title={selectedNode.id}>
              {toCurie(selectedNode.id)}
            </div>
            <div className="badge-row">
              <span className="badge">
                <span className="chip" style={{ background: colorOf(selectedNode.module) }} />
                module {selectedNode.module}
              </span>
              {selectedNode.lobes.map((l) => (
                <span key={l} className="badge">
                  <span
                    className="chip"
                    style={{
                      background: groupMode === "lobes" ? colorOf(l) : "var(--text-muted)",
                    }}
                  />
                  {meta.lobes.find((x) => x.id === l)?.label ?? l}
                </span>
              ))}
            </div>
            {!selectedNode.source && (
              <div className="split-actions">
                {split.open ? (
                  <button
                    className="split-add-btn"
                    onClick={() => toggleSeed(selectedNode.id)}
                  >
                    {split.seeds.includes(selectedNode.id)
                      ? "− Remove from split"
                      : "＋ Add to split"}
                  </button>
                ) : (
                  <button
                    className="split-add-btn"
                    title="Start a structural split (standalone .ttl export) from this class"
                    onClick={() => openSplitWith(selectedNode.id)}
                  >
                    ✂ Split from this class
                  </button>
                )}
                {split.open &&
                  splitMembers?.has(selectedNode.id) &&
                  !split.seeds.includes(selectedNode.id) && (
                    <span
                      className="split-in"
                      title="Included via the expansion rules"
                    >
                      in split ✓
                    </span>
                  )}
              </div>
            )}
            {selectedNode.comment && <p className="comment">{selectedNode.comment}</p>}

            {selectedNode.attributes.length > 0 && (
              <>
                <h4>Attributes ({selectedNode.attributes.length})</h4>
                <table className="attr-table">
                  <tbody>
                    {selectedNode.attributes.map((a) => (
                      <tr key={a.iri} title={a.iri}>
                        <td>{a.label}</td>
                        <td>{a.range ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {selectedNeighbors.length > 0 && (
              <>
                <h4>Relations ({selectedNeighbors.length})</h4>
                {selectedNeighbors.map((nb, i) => (
                  <button
                    key={i}
                    className="neighbor-btn"
                    onClick={() => selectAndFocus(nb.node.id)}
                    title={`${nb.rel} ${nb.dir} ${nb.node.label}`}
                  >
                    <span className="neighbor-rel">
                      {nb.dir} {nb.rel} ·{" "}
                    </span>
                    {nb.node.label}
                  </button>
                ))}
              </>
            )}
          </>
        ) : (
          <div className="empty-hint">
            Click a class or an edge in the graph to see its details,
            <br />
            or search for a class in the left panel.
          </div>
        )}
      </aside>
    </div>
  );
}
