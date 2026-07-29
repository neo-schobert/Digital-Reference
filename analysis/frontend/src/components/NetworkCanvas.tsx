import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import ForceGraph from "force-graph";

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
}

export interface NetworkCanvasHandle {
  focusNode: (id: string) => void;
  zoomToFit: () => void;
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
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const boundsRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const nodeCacheRef = useRef(new Map<string, any>());
  const firstFitRef = useRef(true);

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

    // --- Étirement élastique : le nœud relâché revient dans la disposition ---
    if (typeof fg.onNodeDragEnd === "function") {
      fg.onNodeDragEnd((n: any) => {
        n.fx = null;
        n.fy = null;
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
      const { colorOf, dark, selectedId, neighbors } = stateRef.current;
      const isSelected = selectedId === node.id;
      const isNeighbor =
        selectedId !== null && (neighbors.get(selectedId)?.has(node.id) ?? false);
      const dimmed = selectedId !== null && !isSelected && !isNeighbor;

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
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
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
      cache.set(n.id, obj);
      return obj;
    });
    fg.graphData({ nodes: nodeObjs, links: links.map((l) => ({ ...l })) });
    if (firstFitRef.current && nodes.length > 0) {
      firstFitRef.current = false;
      setTimeout(() => fg.zoomToFit(500, 40), 700);
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
      if (!fg) return;
      const node = fg.graphData().nodes.find((n: any) => n.id === id);
      if (node && typeof node.x === "number") {
        fg.centerAt(node.x, node.y, 600);
        fg.zoom(Math.max(fg.zoom(), 3), 600);
      }
    },
    zoomToFit() {
      fgRef.current?.zoomToFit(500, 40);
    },
  }));

  return <div ref={containerRef} className="graph-canvas" />;
});

export default NetworkCanvas;
