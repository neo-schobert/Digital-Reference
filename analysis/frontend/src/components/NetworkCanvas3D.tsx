import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import ForceGraph3D from "3d-force-graph";
import * as THREE from "three";
import SpriteText from "three-spritetext";
import type { VizLink, VizNode } from "./NetworkCanvas";

export interface NetworkCanvas3DHandle {
  focusNode: (id: string) => void;
  zoomToFit: () => void;
}

interface Props {
  nodes: VizNode[];
  links: VizLink[];
  colorOf: (group: string) => string;
  dark: boolean;
  selectedId: string | null;
  selectedLinkKey: string | null;
  onSelect: (id: string | null) => void;
  onSelectLink: (key: string | null) => void;
  visibleNodeIds?: Set<string> | null;
  visibleLinkKeys?: Set<string> | null;
}

interface AxisDot {
  key: string;
  label: string;
  color: string;
  dir: [number, number, number];
  x: number;
  y: number;
  z: number;
}

const AXES: { key: string; label: string; color: string; dir: [number, number, number] }[] = [
  { key: "+x", label: "X", color: "#e34948", dir: [1, 0, 0] },
  { key: "-x", label: "-X", color: "#e34948", dir: [-1, 0, 0] },
  { key: "+y", label: "Y", color: "#2fa146", dir: [0, 1, 0] },
  { key: "-y", label: "-Y", color: "#2fa146", dir: [0, -1, 0] },
  { key: "+z", label: "Z", color: "#3987e5", dir: [0, 0, 1] },
  { key: "-z", label: "-Z", color: "#3987e5", dir: [0, 0, -1] },
];

function radius3d(degree: number | undefined): number {
  return Math.min(12, 4 + Math.sqrt(degree ?? 1) * 1.3);
}

/**
 * Vue 3D « Blender-like » :
 * - clic droit / clic-molette = rotation, clic gauche = déplacement (pan)
 * - la rotation orbite autour de l'élément sélectionné
 * - gizmo d'axes cliquable (hors du conteneur WebGL pour rester visible)
 * - filtres par visibilité (aucune reconstruction => pas de lag)
 * - simulation maintenue vivante + drag élastique des nœuds
 */
const NetworkCanvas3D = forwardRef<NetworkCanvas3DHandle, Props>(function NetworkCanvas3D(
  {
    nodes,
    links,
    colorOf,
    dark,
    selectedId,
    selectedLinkKey,
    onSelect,
    onSelectLink,
    visibleNodeIds = null,
    visibleLinkKeys = null,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const registryRef = useRef(new Map<string, { mesh: THREE.Mesh; sprite: SpriteText }>());
  const linkSpriteRef = useRef(
    new Map<string, { sprite: SpriteText; source: string; target: string }>()
  );
  const nodeCacheRef = useRef(new Map<string, any>());
  const firstFitRef = useRef(true);
  const [axisDots, setAxisDots] = useState<AxisDot[]>([]);

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

  const visibleCount = visibleNodeIds ? visibleNodeIds.size : nodes.length;

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
    showLabels: true,
  };

  /* ---- Mise en évidence sélection : mutation directe des matériaux ---- */
  const applyHighlight = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const { selectedId, neighbors, showLabels } = stateRef.current;
    registryRef.current.forEach(({ mesh, sprite }, id) => {
      const isSel = id === selectedId;
      const isNb =
        selectedId !== null && (neighbors.get(selectedId)?.has(id) ?? false);
      const dim = selectedId !== null && !isSel && !isNb;
      const mat = mesh.material as THREE.MeshLambertMaterial;
      mat.opacity = dim ? 0.07 : 1;
      sprite.visible = dim ? false : showLabels || isSel || isNb;
    });
    const { selectedId: selId, selectedLinkKey: selKey } = stateRef.current;
    linkSpriteRef.current.forEach(({ sprite, source, target }, key) => {
      const touches =
        (selId !== null && (source === selId || target === selId)) ||
        (selKey !== null && key === selKey);
      sprite.visible = selId === null && selKey === null ? true : touches;
    });
    fg.linkColor(fg.linkColor());
    fg.linkWidth(fg.linkWidth());
  }, []);

  /* ------------------------- Instanciation ------------------------- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const FG: any = ForceGraph3D as any;
    let fg: any;
    try {
      fg = FG.prototype
        ? new FG(el, { controlType: "orbit" })
        : FG({ controlType: "orbit" })(el);
    } catch {
      fg = FG()(el);
    }
    fgRef.current = fg;

    const sphereGeo = new THREE.SphereGeometry(1, 12, 8);

    fg.nodeId("id");
    fg.nodeLabel((n: any) => n.label);

    // --- Simulation vivante : léger mouvement organique permanent ---
    fg.cooldownTicks(Infinity);
    if (typeof fg.cooldownTime === "function") fg.cooldownTime(Infinity);
    if (typeof fg.d3AlphaMin === "function") fg.d3AlphaMin(0);
    if (typeof fg.d3AlphaTarget === "function") fg.d3AlphaTarget(0.015);
    fg.warmupTicks(40);

    // Mouvement organique permanent : oscillation sinusoïdale propre à chaque
    // nœud (zéro en moyenne => pas de dérive globale).
    const AMP = 0.035;
    const jitter: any = () => {
      const t = performance.now() / 1000;
      for (const n of jitter._nodes ?? []) {
        if (n.fx != null) continue;
        if (n.__jp === undefined) {
          n.__jp = Math.random() * Math.PI * 2;
          n.__jw = 0.5 + Math.random() * 0.9; // rad/s
          n.__jq = Math.random() * Math.PI * 2;
          n.__jv = 0.5 + Math.random() * 0.9;
          n.__jr = Math.random() * Math.PI * 2;
          n.__ju = 0.5 + Math.random() * 0.9;
        }
        n.vx += AMP * Math.sin(t * n.__jw + n.__jp);
        n.vy += AMP * Math.cos(t * n.__jv + n.__jq);
        n.vz = (n.vz ?? 0) + AMP * Math.sin(t * n.__ju + n.__jr);
      }
    };
    jitter.initialize = (ns: any[]) => {
      jitter._nodes = ns;
    };
    fg.d3Force("jitter", jitter);

    // --- Drag élastique : relâcher un nœud le laisse revenir en place ---
    if (typeof fg.onNodeDragEnd === "function") {
      fg.onNodeDragEnd((n: any) => {
        n.fx = undefined;
        n.fy = undefined;
        n.fz = undefined;
      });
    }

    // --- Objets 3D des nœuds : sphère + libellé ---
    fg.nodeThreeObject((node: any) => {
      const { colorOf, dark, showLabels } = stateRef.current;
      const r = radius3d(node.degree);
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(
        sphereGeo,
        new THREE.MeshLambertMaterial({
          color: colorOf(node.group),
          transparent: true,
          opacity: 1,
        })
      );
      mesh.scale.setScalar(r);
      const label: string =
        node.label.length > 30 ? node.label.slice(0, 28) + "…" : node.label;
      const sprite = new SpriteText(label, 4.6, dark ? "#c3c2b7" : "#52514e");
      sprite.material.depthWrite = false;
      sprite.position.set(0, -(r + 5), 0);
      sprite.visible = showLabels;
      group.add(mesh);
      group.add(sprite);
      registryRef.current.set(node.id, { mesh, sprite });
      return group;
    });

    // --- Arêtes ---
    fg.linkColor((l: any) => {
      const { dark, selectedId, selectedLinkKey } = stateRef.current;
      if (selectedLinkKey && l.key === selectedLinkKey)
        return dark ? "#7ab3ff" : "#1c5cab";
      const touches =
        selectedId !== null &&
        (l.source?.id === selectedId || l.target?.id === selectedId);
      if ((selectedId !== null || selectedLinkKey !== null) && !touches)
        return dark ? "rgba(90,89,82,0.15)" : "rgba(165,163,155,0.2)";
      if (l.kind === "subclass") return dark ? "#6b6a62" : "#a5a39b";
      return dark ? "#6d8cb5" : "#7a99c0";
    });
    fg.linkOpacity(0.5);
    fg.linkWidth((l: any) =>
      stateRef.current.selectedLinkKey && l.key === stateRef.current.selectedLinkKey
        ? 1.6
        : 0
    );
    if (typeof fg.linkHoverPrecision === "function") fg.linkHoverPrecision(4);
    fg.linkLabel((l: any) => l.label ?? "");
    // Nom de la propriété affiché au milieu des arêtes (comme WebVOWL)
    fg.linkThreeObjectExtend(true);
    fg.linkThreeObject((l: any) => {
      if (l.kind !== "property" || !l.label) return null;
      const { dark } = stateRef.current;
      const text: string = l.label.length > 28 ? l.label.slice(0, 26) + "…" : l.label;
      const sprite = new SpriteText(text, 2.6, dark ? "#8fa8c8" : "#5b7ca6");
      sprite.material.depthWrite = false;
      if (l.key) {
        linkSpriteRef.current.set(l.key, {
          sprite,
          source: typeof l.source === "object" ? l.source.id : l.source,
          target: typeof l.target === "object" ? l.target.id : l.target,
        });
      }
      return sprite;
    });
    fg.linkPositionUpdate((obj: any, { start, end }: any) => {
      if (!obj) return false;
      obj.position.set(
        start.x + (end.x - start.x) / 2,
        start.y + (end.y - start.y) / 2,
        start.z + (end.z - start.z) / 2
      );
      return false;
    });
    fg.linkDirectionalArrowLength(3);
    fg.linkDirectionalArrowRelPos(0.94);

    // --- Interactions ---
    fg.onNodeClick((n: any) => {
      stateRef.current.onSelectLink(null);
      stateRef.current.onSelect(n?.id ?? null);
    });
    fg.onLinkClick((l: any) => {
      stateRef.current.onSelect(null);
      stateRef.current.onSelectLink(l?.key ?? null);
    });
    fg.onBackgroundClick(() => {
      stateRef.current.onSelect(null);
      stateRef.current.onSelectLink(null);
    });
    fg.onLinkHover((l: any) => {
      el.style.cursor = l ? "pointer" : "";
    });
    fg.onNodeHover((n: any) => {
      el.style.cursor = n ? "pointer" : "";
    });

    try {
      fg.showNavInfo?.(false);
    } catch {
      /* option absente selon la version */
    }

    // Contrôles : clic droit / clic-molette = rotation, clic gauche = pan
    const controls = fg.controls();
    if (controls) {
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: THREE.MOUSE.ROTATE,
      };
    }

    // Gizmo : projection des axes dans le repère caméra (boucle rAF légère)
    let raf = 0;
    const lastQ = new THREE.Quaternion(0, 0, 0, 0);
    const tick = () => {
      const cam = fg.camera();
      if (cam && Math.abs(1 - Math.abs(cam.quaternion.dot(lastQ))) > 1e-6) {
        lastQ.copy(cam.quaternion);
        const inv = cam.quaternion.clone().invert();
        setAxisDots(
          AXES.map((a) => {
            const v = new THREE.Vector3(...a.dir).applyQuaternion(inv);
            return { ...a, x: v.x, y: -v.y, z: v.z };
          }).sort((p, q) => p.z - q.z)
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => {
      fg.width(el.clientWidth);
      fg.height(el.clientHeight);
    });
    ro.observe(el);
    fg.width(el.clientWidth);
    fg.height(el.clientHeight);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      fg._destructor?.();
      fgRef.current = null;
      registryRef.current.clear();
      linkSpriteRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------- Données : une seule fois (positions conservées ensuite) ------- */
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const cache = nodeCacheRef.current;
    registryRef.current.clear();
    linkSpriteRef.current.clear();
    const nodeObjs = nodes.map((n) => {
      const existing = cache.get(n.id);
      const obj = existing ? Object.assign(existing, n) : { ...n };
      cache.set(n.id, obj);
      return obj;
    });
    fg.graphData({ nodes: nodeObjs, links: links.map((l) => ({ ...l })) });
    applyHighlight();
    if (firstFitRef.current && nodes.length > 0) {
      firstFitRef.current = false;
      setTimeout(() => fg.zoomToFit(800, 60), 900);
    }
  }, [nodes, links, applyHighlight]);

  /* ------- Filtres : bascule de visibilité, sans reconstruction ------- */
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const nodeSet = visibleNodeIds;
    const linkSet = visibleLinkKeys;
    fg.nodeVisibility((n: any) => !nodeSet || nodeSet.has(n.id));
    fg.linkVisibility((l: any) => !linkSet || !l.key || linkSet.has(l.key));
    applyHighlight();
  }, [visibleNodeIds, visibleLinkKeys, applyHighlight]);

  /* ------- Sélection : surbrillance + la caméra orbite autour ------- */
  useEffect(() => {
    applyHighlight();
    const fg = fgRef.current;
    if (!fg) return;
    // Recentrer la cible d'orbite sur l'élément sélectionné (sans bouger la caméra)
    let target: { x: number; y: number; z: number } | null = null;
    if (selectedId) {
      const n = fg.graphData().nodes.find((n: any) => n.id === selectedId);
      if (n && typeof n.x === "number") target = { x: n.x, y: n.y, z: n.z };
    } else if (selectedLinkKey) {
      const l = fg.graphData().links.find((l: any) => l.key === selectedLinkKey);
      if (l && typeof l.source?.x === "number" && typeof l.target?.x === "number") {
        target = {
          x: (l.source.x + l.target.x) / 2,
          y: (l.source.y + l.target.y) / 2,
          z: (l.source.z + l.target.z) / 2,
        };
      }
    }
    if (target) {
      const p = fg.camera().position;
      fg.cameraPosition({ x: p.x, y: p.y, z: p.z }, target, 500);
    }
  }, [selectedId, selectedLinkKey, applyHighlight]);

  /* ------- Thème / couleurs ------- */
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.backgroundColor(dark ? "#0d0d0d" : "#f9f9f7");
    registryRef.current.forEach(({ mesh, sprite }, id) => {
      const node = nodeCacheRef.current.get(id);
      if (node) {
        (mesh.material as THREE.MeshLambertMaterial).color.set(colorOf(node.group));
      }
      sprite.color = dark ? "#c3c2b7" : "#52514e";
    });
    linkSpriteRef.current.forEach(({ sprite }) => {
      sprite.color = dark ? "#8fa8c8" : "#5b7ca6";
    });
    fg.linkColor(fg.linkColor());
  }, [dark, colorOf]);

  /* ------- API impérative ------- */
  useImperativeHandle(ref, () => ({
    focusNode(id: string) {
      const fg = fgRef.current;
      if (!fg) return;
      const node = fg.graphData().nodes.find((n: any) => n.id === id);
      if (node && typeof node.x === "number") {
        const dist = 130;
        const norm = Math.hypot(node.x, node.y, node.z) || 1;
        const ratio = 1 + dist / norm;
        fg.cameraPosition(
          { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio },
          node,
          800
        );
      }
    },
    zoomToFit() {
      fgRef.current?.zoomToFit(800, 60);
    },
  }));

  /* ------- Alignement caméra sur un axe (gizmo) ------- */
  const alignTo = (dir: [number, number, number]) => {
    const fg = fgRef.current;
    if (!fg) return;
    const cam = fg.camera();
    const controls = fg.controls();
    const target = controls?.target ?? new THREE.Vector3(0, 0, 0);
    const dist = cam.position.distanceTo(target) || 400;
    fg.cameraPosition(
      {
        x: target.x + dir[0] * dist,
        y: target.y + dir[1] * dist,
        z: target.z + dir[2] * dist,
      },
      { x: target.x, y: target.y, z: target.z },
      700
    );
  };

  const R = 34;
  return (
    <div className="graph-canvas">
      {/* Conteneur WebGL séparé : les overlays (gizmo, aide) restent au-dessus */}
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      <div className="gizmo" title="Align the view to an axis (Blender-style)">
        <svg width="96" height="96" viewBox="0 0 96 96">
          <circle
            cx="48"
            cy="48"
            r="46"
            fill={dark ? "rgba(26,26,25,0.55)" : "rgba(252,252,251,0.6)"}
          />
          {axisDots.map((a) => {
            const cx = 48 + a.x * R;
            const cy = 48 + a.y * R;
            const front = a.z >= 0;
            const positive = !a.label.startsWith("-");
            return (
              <g
                key={a.key}
                onClick={() => alignTo(a.dir)}
                style={{ cursor: "pointer" }}
                opacity={front ? 1 : 0.45}
              >
                <line
                  x1="48"
                  y1="48"
                  x2={cx}
                  y2={cy}
                  stroke={a.color}
                  strokeWidth={positive ? 1.6 : 0}
                />
                <circle
                  cx={cx}
                  cy={cy}
                  r={positive ? 8 : 6}
                  fill={positive ? a.color : dark ? "#1a1a19" : "#fcfcfb"}
                  stroke={a.color}
                  strokeWidth="1.5"
                />
                {positive && (
                  <text
                    x={cx}
                    y={cy + 3}
                    textAnchor="middle"
                    fill="#ffffff"
                    style={{ font: "600 9px system-ui", pointerEvents: "none" }}
                  >
                    {a.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="hint-nav">
        right-click / middle-click: rotate (around the selection) · left-click:
        pan · wheel: zoom · drag a node: elastic stretch
      </div>
    </div>
  );
});

export default NetworkCanvas3D;
