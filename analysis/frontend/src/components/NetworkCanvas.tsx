import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import ForceGraph from "force-graph";
import { getPin, removePin, setPin } from "../pinStore";

export interface VizNode {
  id: string;
  label: string;
  group: string;
  degree?: number;
}

export interface VizLink {
  source: string;
  target: string;
  kind: "subclass" | "property" | "generic";
  label?: string;
  /** Identifiant stable de l'arête (sélection / visibilité) */
  key?: string;
  /** Slot du label pour les arêtes parallèles (…-1, 0, 1…) */
  lslot?: number;
  /** Sens du lien par rapport à l'ordre canonique de la paire */
  lflip?: boolean;
  /** Position du label le long de l'arête (0..1, défaut 0.5) */
  lt?: number;
}

export interface NetworkCanvasHandle {
  /** Centre la vue sur le nœud ; false si le nœud n'est pas encore prêt. */
  focusNode: (id: string) => boolean;
  zoomToFit: () => void;
  /** Libère tous les nœuds épinglés (l'élasticité reprend). */
  resetPins: () => void;
}

interface Props {
  nodes: VizNode[];
  links: VizLink[];
  colorOf: (group: string) => string;
  dark: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  selectedLinkKey?: string | null;
  onSelectLink?: (key: string | null) => void;
  /** Filtrage par visibilité : pas de reconstruction des données => aucun lag,
      et les nœuds masqués disparaissent en place. null/undefined = tout visible. */
  visibleNodeIds?: Set<string> | null;
  visibleLinkKeys?: Set<string> | null;
  /** Sélection d'une couche entière (ex. une ontologie) : tout le reste
      est estompé. Prioritée moindre que la sélection de nœud/arête. */
  highlightIds?: Set<string> | null;
}

export function nodeRadius(degree: number | undefined): number {
  return Math.min(16, 5.5 + Math.sqrt(degree ?? 1) * 1.5);
}

/**
 * Rendu force-directed 2D « WebVOWL-like » sur canvas.
 * - simulation maintenue vivante (léger mouvement organique permanent)
 * - nœuds étirables à la souris, retour élastique au relâchement
 * - sélection de nœuds ET d'arêtes
 */
const NetworkCanvas = forwardRef<NetworkCanvasHandle, Props>(function NetworkCanvas(
  {
    nodes,
    links,
    colorOf,
    dark,
    selectedId,
    onSelect,
    selectedLinkKey = null,
    onSelectLink,
    visibleNodeIds = null,
    visibleLinkKeys = null,
    highlightIds = null,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const boundsRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const nodeCacheRef = useRef(new Map<string, any>());
  const linkCacheRef = useRef(new Map<string, any>());
  const firstFitRef = useRef(true);
  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Voisinage restreint aux arêtes visibles (pour la mise en évidence)
  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      if (!map.has(a)) map.set(a, new Set());
      map.get(a)!.add(b);
    };
    for (const l of links) {
      if (visibleLinkKeys && l.key && !visibleLinkKeys.has(l.key)) continue;
      add(l.source, l.target);
      add(l.target, l.source);
    }
    return map;
  }, [links, visibleLinkKeys]);

  const stateRef = useRef<any>({});
  stateRef.current = {
    colorOf,
    dark,
    selectedId,
    selectedLinkKey,
    neighbors,
    onSelect,
    onSelectLink,
    visibleNodeIds,
    visibleLinkKeys,
    highlightIds,
  };

  // Instanciation unique
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const FG: any = ForceGraph as any;
    // force-graph >= 1.47 : constructeur de classe ; avant : factory
    const fg = FG.prototype ? new FG(el) : FG()(el);
    fgRef.current = fg;

    fg.nodeId("id");
    fg.nodeLabel((n: any) => n.label);
    fg.minZoom(0.05);
    fg.maxZoom(12);

    // --- Simulation vivante en continu : léger mouvement permanent ---
    fg.cooldownTicks(Infinity);
    if (typeof fg.cooldownTime === "function") fg.cooldownTime(Infinity);
    if (typeof fg.d3AlphaMin === "function") fg.d3AlphaMin(0);
    if (typeof fg.d3AlphaTarget === "function") fg.d3AlphaTarget(0.015);
    fg.d3AlphaDecay(0.03);
    fg.d3VelocityDecay(0.35);
    if (typeof fg.autoPauseRedraw === "function") fg.autoPauseRedraw(false);

    // Mouvement organique permanent : chaque nœud oscille lentement selon une
    // sinusoïde qui lui est propre (zéro en moyenne => pas de dérive globale).
    const AMP = 0.03; // amplitude de vitesse par tick (~3 px d'oscillation)
    const jitter: any = () => {
      const t = performance.now() / 1000;
      for (const n of jitter._nodes ?? []) {
        if (n.fx != null) continue;
        if (n.__jp === undefined) {
          n.__jp = Math.random() * Math.PI * 2;
          n.__jw = 0.5 + Math.random() * 0.9; // rad/s
          n.__jq = Math.random() * Math.PI * 2;
          n.__jv = 0.5 + Math.random() * 0.9;
        }
        n.vx += AMP * Math.sin(t * n.__jw + n.__jp);
        n.vy += AMP * Math.cos(t * n.__jv + n.__jq);
      }
    };
    jitter.initialize = (ns: any[]) => {
      jitter._nodes = ns;
    };
    fg.d3Force("jitter", jitter);

    // Répulsion allégée (voir NetworkCanvas3D) : gros gain CPU en continu
    const charge = fg.d3Force("charge");
    charge?.theta?.(1.2);
    charge?.distanceMax?.(420);

    // --- Étirement élastique + épinglage : un nœud maintenu ~immobile en fin
    // de drag reste fixé sur place (fx/fy) ; relâché en mouvement, il reste
    // élastique — ce qui sert aussi à dé-épingler d'un petit coup sec. ---
    // NB : les événements de drag ne tombent QUE quand la souris bouge ; le
    // maintien immobile est donc détecté par minuterie, pas par événement.
    const PIN_HOLD_MS = 850;
    const dragState = {
      id: null as string | null,
      x: 0,
      y: 0,
      armed: false,
      timer: null as ReturnType<typeof setTimeout> | null,
    };
    const armLater = (n: any) => {
      if (dragState.timer) clearTimeout(dragState.timer);
      dragState.timer = setTimeout(() => {
        if (dragState.id === n.id) dragState.armed = true; // anneau à l'écran
      }, PIN_HOLD_MS);
    };
    if (typeof fg.onNodeDrag === "function") {
      fg.onNodeDrag((n: any) => {
        if (dragState.id !== n.id) {
          dragState.id = n.id;
          dragState.x = n.x;
          dragState.y = n.y;
          dragState.armed = n.__pinned === true; // re-drag d'un nœud épinglé
          if (!dragState.armed) armLater(n);
          return;
        }
        // Tolérance ~5 px écran : une main « à peu près immobile » suffit
        const eps = 5 / (fg.zoom() || 1);
        if (Math.hypot(n.x - dragState.x, n.y - dragState.y) > eps) {
          dragState.x = n.x;
          dragState.y = n.y;
          dragState.armed = false; // reparti en mouvement : lâcher libérera
          armLater(n);
        }
      });
    }
    if (typeof fg.onNodeDragEnd === "function") {
      fg.onNodeDragEnd((n: any) => {
        const pin = dragState.id === n.id && dragState.armed;
        if (dragState.timer) {
          clearTimeout(dragState.timer);
          dragState.timer = null;
        }
        dragState.id = null;
        dragState.armed = false;
        n.__pinned = pin;
        n.fx = pin ? n.x : null;
        n.fy = pin ? n.y : null;
        if (pin) setPin("2d", n.id, [n.x, n.y]);
        else removePin("2d", n.id);
      });
    }

    // --- Interactions : hit-test manuel au clic (fiable même quand le graphe
    // bouge, contrairement au picking par survol de la lib) ---
    const distToSegment = (
      px: number, py: number,
      ax: number, ay: number, bx: number, by: number
    ) => {
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
    };
    const clickHandler = (ev: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const { x: gx, y: gy } = fg.screen2GraphCoords(
        ev.clientX - rect.left,
        ev.clientY - rect.top
      );
      const k = fg.zoom();
      const slack = 8 / k; // 8 px écran de tolérance
      const { visibleNodeIds, visibleLinkKeys, onSelect, onSelectLink } = stateRef.current;
      const data = fg.graphData();

      let bestNode: any = null;
      let bestD = Infinity;
      for (const n of data.nodes) {
        if (visibleNodeIds && !visibleNodeIds.has(n.id)) continue;
        if (typeof n.x !== "number") continue;
        const d = Math.hypot(n.x - gx, n.y - gy);
        if (d < nodeRadius(n.degree) + slack && d < bestD) {
          bestD = d;
          bestNode = n;
        }
      }
      if (bestNode) {
        onSelectLink?.(null);
        onSelect(bestNode.id);
        return;
      }

      let bestLink: any = null;
      bestD = Infinity;
      for (const l of data.links) {
        if (visibleLinkKeys && l.key && !visibleLinkKeys.has(l.key)) continue;
        const s = l.source, t = l.target;
        if (typeof s?.x !== "number" || typeof t?.x !== "number") continue;
        const d = distToSegment(gx, gy, s.x, s.y, t.x, t.y);
        if (d < slack && d < bestD) {
          bestD = d;
          bestLink = l;
        }
      }
      if (bestLink) {
        onSelect(null);
        onSelectLink?.(bestLink.key ?? null);
        return;
      }
      onSelect(null);
      onSelectLink?.(null);
    };
    el.addEventListener("click", clickHandler);

    fg.onNodeHover((n: any) => {
      el.style.cursor = n ? "pointer" : "";
    });
    if (typeof fg.linkHoverPrecision === "function") fg.linkHoverPrecision(8);

    // Bornes du viewport (en coordonnées graphe) calculées une fois par frame :
    // permet de ne pas dessiner nœuds/labels hors écran (aucune perte visuelle).
    if (typeof fg.onRenderFramePre === "function") {
      fg.onRenderFramePre((_ctx: CanvasRenderingContext2D, scale: number) => {
        const tl = fg.screen2GraphCoords(0, 0);
        const br = fg.screen2GraphCoords(el.clientWidth, el.clientHeight);
        const m = 60 / scale;
        boundsRef.current = { x1: tl.x - m, y1: tl.y - m, x2: br.x + m, y2: br.y + m };
      });
    }

    // --- Rendu des nœuds ---
    fg.nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, scale: number) => {
      const b = boundsRef.current;
      if (b && (node.x < b.x1 || node.x > b.x2 || node.y < b.y1 || node.y > b.y2)) return;
      const { colorOf, dark, selectedId, neighbors, highlightIds } = stateRef.current;
      const isSelected = selectedId === node.id;
      const isNeighbor =
        selectedId !== null && (neighbors.get(selectedId)?.has(node.id) ?? false);
      const dimmed =
        selectedId !== null
          ? !isSelected && !isNeighbor
          : highlightIds !== null && !highlightIds.has(node.id);

      const r = nodeRadius(node.degree);
      ctx.globalAlpha = dimmed ? 0.15 : 1;

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = colorOf(node.group);
      ctx.fill();

      ctx.lineWidth = isSelected ? 2.5 / scale : 1 / scale;
      ctx.strokeStyle = isSelected
        ? dark
          ? "#ffffff"
          : "#0b0b0b"
        : dark
          ? "rgba(255,255,255,0.35)"
          : "rgba(11,11,11,0.25)";
      ctx.stroke();

      // Anneau d'épinglage : pendant le maintien (armé) et une fois fixé
      if (node.__pinned || (dragState.id === node.id && dragState.armed)) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 3, 0, 2 * Math.PI);
        ctx.lineWidth = 1.4 / scale;
        ctx.strokeStyle = "#e8a33d";
        ctx.setLineDash([4 / scale, 3 / scale]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if ((scale > 0.5 || isSelected || isNeighbor) && !dimmed) {
        const fontSize = Math.max(12 / scale, 3.2);
        ctx.font = `${isSelected ? "600 " : ""}${fontSize}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const label: string =
          node.label.length > 34 ? node.label.slice(0, 32) + "…" : node.label;
        ctx.lineWidth = 3 / scale;
        ctx.strokeStyle = dark ? "rgba(13,13,13,0.85)" : "rgba(249,249,247,0.9)";
        ctx.strokeText(label, node.x, node.y + r + 2 / scale);
        ctx.fillStyle = dark ? "#c3c2b7" : "#52514e";
        ctx.fillText(label, node.x, node.y + r + 2 / scale);
      }
      ctx.globalAlpha = 1;
    });

    fg.nodePointerAreaPaint((node: any, color: string, ctx: CanvasRenderingContext2D) => {
      const r = nodeRadius(node.degree) + 4;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fill();
    });

    // --- Rendu des arêtes ---
    fg.linkColor((l: any) => {
      const { dark, selectedId, selectedLinkKey } = stateRef.current;
      if (selectedLinkKey && l.key === selectedLinkKey)
        return dark ? "#7ab3ff" : "#1c5cab";
      const active =
        selectedId !== null &&
        (l.source?.id === selectedId || l.target?.id === selectedId);
      if ((selectedId !== null || selectedLinkKey !== null) && !active) {
        return dark ? "rgba(90,89,82,0.12)" : "rgba(165,163,155,0.15)";
      }
      const hl = stateRef.current.highlightIds;
      if (selectedId === null && selectedLinkKey === null && hl) {
        const s = l.source?.id ?? l.source;
        const t = l.target?.id ?? l.target;
        if (!hl.has(s) && !hl.has(t))
          return dark ? "rgba(90,89,82,0.12)" : "rgba(165,163,155,0.15)";
      }
      if (l.kind === "subclass") return dark ? "#5a5952" : "#a5a39b";
      return dark ? "#5f7ea6" : "#7a99c0";
    });
    if (typeof fg.linkLineDash === "function") {
      fg.linkLineDash((l: any) => (l.kind === "subclass" ? [3, 2] : null));
    }
    fg.linkWidth((l: any) => {
      const { selectedId, selectedLinkKey } = stateRef.current;
      if (selectedLinkKey && l.key === selectedLinkKey) return 2.5;
      const active =
        selectedId !== null &&
        (l.source?.id === selectedId || l.target?.id === selectedId);
      return active ? 1.8 : 0.7;
    });
    fg.linkDirectionalArrowLength(3.5);
    fg.linkDirectionalArrowRelPos(0.92);
    fg.linkLabel((l: any) => l.label ?? "");

    // Libellés d'arêtes au zoom, autour de la sélection, ou arête sélectionnée
    fg.linkCanvasObjectMode(() => "after");
    fg.linkCanvasObject((l: any, ctx: CanvasRenderingContext2D, scale: number) => {
      const { dark, selectedId, selectedLinkKey } = stateRef.current;
      if (!l.label || l.kind === "subclass") return;
      const isSelLink = selectedLinkKey !== null && l.key === selectedLinkKey;
      const active =
        isSelLink ||
        (selectedId !== null &&
          (l.source?.id === selectedId || l.target?.id === selectedId));
      if (scale < 1.1 && !active) return;
      if ((selectedId !== null || selectedLinkKey !== null) && !active) return;
      const sx = l.source?.x, sy = l.source?.y, tx = l.target?.x, ty = l.target?.y;
      if ([sx, sy, tx, ty].some((v) => typeof v !== "number")) return;
      const t = l.lt ?? 0.5;
      let mx = sx + (tx - sx) * t;
      let my = sy + (ty - sy) * t;
      if (l.lslot !== undefined && l.lslot !== 0) {
        const dx = tx - sx;
        const dy = ty - sy;
        const len = Math.hypot(dx, dy) || 1;
        let px = -dy / len;
        let py = dx / len;
        if (l.lflip) {
          px = -px;
          py = -py;
        }
        const gap = Math.max(6 / scale, 2.5);
        mx += px * gap * l.lslot;
        my += py * gap * l.lslot;
      }
      const b = boundsRef.current;
      if (b && (mx < b.x1 || mx > b.x2 || my < b.y1 || my > b.y2)) return;
      const fontSize = Math.max(10 / scale, 2.2);
      ctx.font = `${isSelLink ? "600 " : ""}${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const text: string = l.label.length > 30 ? l.label.slice(0, 28) + "…" : l.label;
      ctx.lineWidth = 2.5 / scale;
      ctx.strokeStyle = dark ? "rgba(13,13,13,0.8)" : "rgba(249,249,247,0.85)";
      ctx.strokeText(text, mx, my);
      ctx.fillStyle = isSelLink
        ? dark
          ? "#7ab3ff"
          : "#1c5cab"
        : dark
          ? "#8fa8c8"
          : "#5b7ca6";
      ctx.fillText(text, mx, my);
    });

    const ro = new ResizeObserver(() => {
      fg.width(el.clientWidth);
      fg.height(el.clientHeight);
    });
    ro.observe(el);
    fg.width(el.clientWidth);
    fg.height(el.clientHeight);

    return () => {
      el.removeEventListener("click", clickHandler);
      ro.disconnect();
      fg._destructor?.();
      fgRef.current = null;
    };
  }, []);

  // Données : chargées une seule fois (ou au changement de mode de groupement).
  // Les objets nœuds sont réutilisés pour conserver les positions.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const cache = nodeCacheRef.current;
    const nodeObjs = nodes.map((n) => {
      const existing = cache.get(n.id);
      const obj = existing ? Object.assign(existing, n) : { ...n };
      // Épinglages restaurés (session en cours ou sauvegarde « Save »)
      const pin = getPin("2d", n.id);
      if (pin && obj.__pinned !== true) {
        obj.x = pin[0];
        obj.y = pin[1];
        obj.fx = pin[0];
        obj.fy = pin[1];
        obj.__pinned = true;
      }
      cache.set(n.id, obj);
      return obj;
    });
    // Liens réutilisés par identité : la simulation d3 ne réinitialise que
    // les éléments nouveaux, pas tout le layout.
    const linkCache = linkCacheRef.current;
    const linkObjs = links.map((l) => {
      const key = l.key ?? `${l.source}|${l.target}|${l.label ?? ""}`;
      const existing = linkCache.get(key);
      const obj = existing ? Object.assign(existing, l) : { ...l };
      linkCache.set(key, obj);
      return obj;
    });
    fg.graphData({ nodes: nodeObjs, links: linkObjs });
    if (firstFitRef.current && nodes.length > 0) {
      firstFitRef.current = false;
      // Fit initial SAUF si une sélection est déjà demandée (focus depuis le
      // chat) : sinon il écraserait le centrage sur le nœud sélectionné.
      fitTimerRef.current = setTimeout(() => {
        const { selectedId, selectedLinkKey } = stateRef.current;
        if (!selectedId && !selectedLinkKey) fg.zoomToFit(500, 40);
      }, 700);
    }
  }, [nodes, links]);

  // Filtres : simple bascule de visibilité, sans reconstruction => instantané
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const nodeSet = visibleNodeIds;
    const linkSet = visibleLinkKeys;
    fg.nodeVisibility((n: any) => !nodeSet || nodeSet.has(n.id));
    fg.linkVisibility((l: any) => !linkSet || !l.key || linkSet.has(l.key));
  }, [visibleNodeIds, visibleLinkKeys]);

  useImperativeHandle(ref, () => ({
    focusNode(id: string) {
      const fg = fgRef.current;
      if (!fg) return false;
      const node = fg.graphData().nodes.find((n: any) => n.id === id);
      if (node && typeof node.x === "number") {
        if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
        fg.centerAt(node.x, node.y, 600);
        fg.zoom(Math.max(fg.zoom(), 3), 600);
        return true;
      }
      return false;
    },
    zoomToFit() {
      fgRef.current?.zoomToFit(500, 40);
    },
    resetPins() {
      const fg = fgRef.current;
      if (!fg) return;
      for (const n of fg.graphData().nodes) {
        if (n.__pinned) {
          n.__pinned = false;
          n.fx = null;
          n.fy = null;
        }
      }
    },
  }));

  return <div ref={containerRef} className="graph-canvas" />;
});

export default NetworkCanvas;
