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
import { getPin, removePin, setPin } from "../pinStore";
import type { VizLink, VizNode } from "./NetworkCanvas";

export interface NetworkCanvas3DHandle {
  /** Vole vers le nœud ; false si le nœud n'est pas encore prêt. */
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
  selectedLinkKey: string | null;
  onSelect: (id: string | null) => void;
  onSelectLink: (key: string | null) => void;
  visibleNodeIds?: Set<string> | null;
  visibleLinkKeys?: Set<string> | null;
  /** Sélection d'une couche entière : le reste est estompé (priorité
      moindre que la sélection de nœud/arête). */
  highlightIds?: Set<string> | null;
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

/* Texture partagée de l'anneau « épinglé » (créée au premier usage) */
let ringTexSingleton: THREE.CanvasTexture | null = null;
function ringTexture(): THREE.CanvasTexture {
  if (!ringTexSingleton) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    if (g) {
      g.strokeStyle = "#e8a33d";
      g.lineWidth = 4;
      g.setLineDash([7, 5]);
      g.beginPath();
      g.arc(32, 32, 27, 0, Math.PI * 2);
      g.stroke();
    }
    ringTexSingleton = new THREE.CanvasTexture(c);
  }
  return ringTexSingleton;
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
    highlightIds = null,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  // Les SpriteText (textures canvas) sont LE coût dominant à la création :
  // ils sont fabriqués paresseusement, seulement quand le LOD les rend
  // visibles, avec un budget par passe pour ne jamais bloquer une frame.
  const registryRef = useRef(
    new Map<
      string,
      {
        group: THREE.Group;
        mesh: THREE.Mesh;
        sprite: SpriteText | null;
        /** Anneau « épinglé » (créé paresseusement au premier pin) */
        pin: THREE.Sprite | null;
        label: string;
        r: number;
      }
    >()
  );
  const linkSpriteRef = useRef(
    new Map<
      string,
      {
        holder: THREE.Group;
        sprite: SpriteText | null;
        text: string;
        source: string;
        target: string;
      }
    >()
  );
  const nodeCacheRef = useRef(new Map<string, any>());
  const linkCacheRef = useRef(new Map<string, any>());
  const firstFitRef = useRef(true);
  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadSelectionRef = useRef(false);
  // Suivi du pivot d'orbite : la cible reste collée à la sélection même si
  // elle bouge (drag du nœud sélectionné, drag des voisins, physique).
  const followRef = useRef<{
    mode: "settle" | "track";
    last: THREE.Vector3 | null;
    getPos: () => THREE.Vector3 | null;
  } | null>(null);
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
    highlightIds,
    showLabels: true,
  };

  /* ---- LOD : ne montrer que les labels lisibles depuis la caméra ----
     (un texte projeté sous ~6,5 px est illisible : le masquer ne retire
     aucune information et économise des centaines de draw calls) ---- */
  const updateLabelVisibility = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const cam = fg.camera();
    if (!cam) return;
    const { selectedId, selectedLinkKey, neighbors, dark, highlightIds: hl } =
      stateRef.current;
    const cp = cam.position;
    const vh = typeof fg.height === "function" ? fg.height() : 800;
    const fovRad = (((cam as any).fov ?? 50) * Math.PI) / 180;
    const pxPerUnit = vh / (2 * Math.tan(fovRad / 2)); // à distance 1
    const MIN_PX = 6.5;
    const nodeLimit = (4.6 * pxPerUnit) / MIN_PX;
    const linkLimit = (2.6 * pxPerUnit) / MIN_PX;

    // Budget de rasterisation par passe : lisse les zooms brutaux
    let budget = 90;

    registryRef.current.forEach((entry, id) => {
      const isSel = id === selectedId;
      const isNb =
        selectedId !== null && (neighbors.get(selectedId)?.has(id) ?? false);
      const dimmed =
        selectedId !== null
          ? !isSel && !isNb
          : hl !== null && !hl.has(id);
      let want = false;
      if (dimmed) want = false;
      else if (isSel || isNb) want = true;
      else want = cp.distanceTo(entry.group.position) < nodeLimit;
      if (want && !entry.sprite) {
        if (budget <= 0 && !isSel && !isNb) return; // au prochain tick
        budget--;
        const s = new SpriteText(entry.label, 4.6, dark ? "#c3c2b7" : "#52514e");
        s.material.depthWrite = false;
        s.position.set(0, -(entry.r + 5), 0);
        entry.group.add(s);
        entry.sprite = s;
      }
      if (entry.sprite) entry.sprite.visible = want;
    });

    linkSpriteRef.current.forEach((entry, key) => {
      let want: boolean;
      if (selectedId !== null || selectedLinkKey !== null) {
        want =
          (selectedId !== null &&
            (entry.source === selectedId || entry.target === selectedId)) ||
          (selectedLinkKey !== null && key === selectedLinkKey);
      } else if (hl !== null && !hl.has(entry.source) && !hl.has(entry.target)) {
        want = false; // arête hors de la couche sélectionnée
      } else {
        want = cp.distanceTo(entry.holder.position) < linkLimit;
      }
      const forced = selectedId !== null || selectedLinkKey !== null;
      if (want && !entry.sprite) {
        if (budget <= 0 && !forced) return;
        budget--;
        const s = new SpriteText(entry.text, 2.6, dark ? "#8fa8c8" : "#5b7ca6");
        s.material.depthWrite = false;
        entry.holder.add(s);
        entry.sprite = s;
      }
      if (entry.sprite) entry.sprite.visible = want;
    });
  }, []);

  /* ---- Mise en évidence sélection : mutation directe des matériaux ---- */
  const applyHighlight = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const { selectedId, neighbors } = stateRef.current;
    const hl = stateRef.current.highlightIds;
    registryRef.current.forEach((entry, id) => {
      const isSel = id === selectedId;
      const isNb =
        selectedId !== null && (neighbors.get(selectedId)?.has(id) ?? false);
      const dim =
        selectedId !== null
          ? !isSel && !isNb
          : hl !== null && !hl.has(id);
      const mat = entry.mesh.material as THREE.MeshLambertMaterial;
      mat.opacity = dim ? 0.07 : 1;
    });
    updateLabelVisibility();
    fg.linkColor(fg.linkColor());
    fg.linkWidth(fg.linkWidth());
  }, [updateLabelVisibility]);

  /* Anneau « épinglé » : sprite face caméra, créé paresseusement */
  const setPinRing = useCallback((id: string, on: boolean) => {
    const entry = registryRef.current.get(id);
    if (!entry) return;
    if (on && !entry.pin) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: ringTexture(),
          transparent: true,
          depthWrite: false,
        })
      );
      s.scale.setScalar(entry.r * 3.1);
      entry.group.add(s);
      entry.pin = s;
    }
    if (entry.pin) entry.pin.visible = on;
  }, []);

  const alignAnimRef = useRef<number | null>(null);

  const cancelAlign = useCallback(() => {
    if (alignAnimRef.current !== null) {
      cancelAnimationFrame(alignAnimRef.current);
      alignAnimRef.current = null;
    }
  }, []);

  /* ------------------------- Instanciation ------------------------- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const FG: any = ForceGraph3D as any;
    let fg: any;
    try {
      const opts = {
        controlType: "orbit",
        rendererConfig: { antialias: true, powerPreference: "high-performance" },
      };
      fg = FG.prototype ? new FG(el, opts) : FG(opts)(el);
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
    fg.warmupTicks(40); // uniquement le premier lot (remis à 0 ensuite)

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

    // Répulsion : precision Barnes-Hut relâchée + portée bornée. La force
    // many-body est LE coût dominant de la simulation perpétuelle ; ces deux
    // réglages la divisent par ~3-4 sans changement visuel perceptible.
    const charge = fg.d3Force("charge");
    charge?.theta?.(1.2);
    charge?.distanceMax?.(420);

    // --- Drag élastique + épinglage : un nœud maintenu ~immobile en fin de
    // drag reste fixé (fx/fy/fz) ; relâché en mouvement, il reste élastique —
    // ce qui sert aussi à dé-épingler d'un petit coup sec. ---
    const PIN_HOLD_MS = 850;
    // NB : les événements de drag ne tombent QUE quand la souris bouge ; le
    // maintien immobile est donc détecté par minuterie, pas par événement.
    const dragState = {
      id: null as string | null,
      x: 0,
      y: 0,
      z: 0,
      armed: false,
      timer: null as ReturnType<typeof setTimeout> | null,
    };
    const armLater = (n: any) => {
      if (dragState.timer) clearTimeout(dragState.timer);
      dragState.timer = setTimeout(() => {
        if (dragState.id === n.id) {
          dragState.armed = true;
          setPinRing(n.id, true); // l'anneau apparaît : lâcher épinglera
        }
      }, PIN_HOLD_MS);
    };
    if (typeof fg.onNodeDrag === "function") {
      fg.onNodeDrag((n: any) => {
        if (dragState.id !== n.id) {
          dragState.id = n.id;
          dragState.x = n.x;
          dragState.y = n.y;
          dragState.z = n.z ?? 0;
          dragState.armed = n.__pinned === true; // re-drag d'un nœud épinglé
          if (!dragState.armed) armLater(n);
          return;
        }
        const d = Math.hypot(
          n.x - dragState.x,
          n.y - dragState.y,
          (n.z ?? 0) - dragState.z
        );
        if (d > 2.5) {
          dragState.x = n.x;
          dragState.y = n.y;
          dragState.z = n.z ?? 0;
          if (dragState.armed) {
            dragState.armed = false;
            setPinRing(n.id, false); // feedback : lâcher maintenant libérera
          }
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
        n.fx = pin ? n.x : undefined;
        n.fy = pin ? n.y : undefined;
        n.fz = pin ? n.z : undefined;
        setPinRing(n.id, pin);
        if (pin) setPin("3d", n.id, [n.x, n.y, n.z]);
        else removePin("3d", n.id);
      });
    }

    // --- Objets 3D des nœuds : sphère + libellé ---
    fg.nodeThreeObject((node: any) => {
      const { colorOf } = stateRef.current;
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
      group.add(mesh);
      const label: string =
        node.label.length > 30 ? node.label.slice(0, 28) + "…" : node.label;
      // Pas de SpriteText ici : créé par le LOD quand il devient visible
      registryRef.current.set(node.id, { group, mesh, sprite: null, pin: null, label, r });
      if (node.__pinned) setPinRing(node.id, true);
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
      const hl = stateRef.current.highlightIds;
      if (selectedId === null && selectedLinkKey === null && hl) {
        const s = l.source?.id ?? l.source;
        const t = l.target?.id ?? l.target;
        if (!hl.has(s) && !hl.has(t))
          return dark ? "rgba(90,89,82,0.15)" : "rgba(165,163,155,0.2)";
      }
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
      const text: string = l.label.length > 28 ? l.label.slice(0, 26) + "…" : l.label;
      // Porteur vide positionné par linkPositionUpdate ; le SpriteText (coûteux
      // à rasteriser) n'est créé par le LOD que s'il devient visible.
      const holder = new THREE.Group();
      if (l.key) {
        linkSpriteRef.current.set(l.key, {
          holder,
          sprite: null,
          text,
          source: typeof l.source === "object" ? l.source.id : l.source,
          target: typeof l.target === "object" ? l.target.id : l.target,
        });
      }
      return holder;
    });
    fg.linkPositionUpdate((obj: any, { start, end }: any, l: any) => {
      if (!obj) return false;
      const t = l?.lt ?? 0.5;
      let mx = start.x + (end.x - start.x) * t;
      let my = start.y + (end.y - start.y) * t;
      let mz = start.z + (end.z - start.z) * t;
      if (l?.lslot !== undefined && l.lslot !== 0) {
        // Perpendiculaire au segment (cohérente pour la paire via lflip)
        const ux = end.x - start.x;
        const uy = end.y - start.y;
        const uz = end.z - start.z;
        let px = -uz;
        let py = 0;
        let pz = ux;
        let n = Math.hypot(px, py, pz);
        if (n < 1e-3) {
          px = 0;
          py = uz;
          pz = -uy;
          n = Math.hypot(px, py, pz) || 1;
        }
        px /= n;
        py /= n;
        pz /= n;
        if (l.lflip) {
          px = -px;
          py = -py;
          pz = -pz;
        }
        const gap = 3.6;
        mx += px * gap * l.lslot;
        my += py * gap * l.lslot;
        mz += pz * gap * l.lslot;
      }
      obj.position.set(mx, my, mz);
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
      controls.addEventListener?.("start", cancelAlign);
    }

    // Gizmo : projection des axes dans le repère caméra (boucle rAF légère)
    let raf = 0;
    let lastLod = 0;
    const lastQ = new THREE.Quaternion(0, 0, 0, 0);
    const tick = () => {
      const nowMs = performance.now();
      if (nowMs - lastLod > 200) {
        lastLod = nowMs;
        updateLabelVisibility();
      }
      // Pivot d'orbite : suit la sélection en continu. « settle » = rattrapage
      // doux vers la cible, puis « track » = translation par deltas (ce qui
      // préserve un éventuel pan manuel de l'utilisateur).
      const follow = followRef.current;
      if (follow && controls) {
        if (alignAnimRef.current !== null) {
          follow.mode = "settle"; // pivot figé pendant un alignement d'axe
        } else {
          const pos = follow.getPos();
          if (pos) {
            if (follow.mode === "settle") {
              controls.target.lerp(pos, 0.12);
              if (controls.target.distanceTo(pos) < 0.5) {
                follow.mode = "track";
                follow.last = pos.clone();
              }
            } else if (follow.last) {
              controls.target.add(pos.clone().sub(follow.last));
              follow.last = pos;
            }
          }
        }
      }
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

    try {
      // 1.5 max : sur écran hi-dpi, passer de 2 à 1.5 réduit le nombre de
      // pixels rendus de ~44 % pour une netteté quasi identique sur un graphe.
      fg.renderer()?.setPixelRatio?.(Math.min(window.devicePixelRatio || 1, 1.5));
    } catch {
      /* selon la version */
    }

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
      cancelAlign();
      fgRef.current = null;
      registryRef.current.clear();
      linkSpriteRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateLabelVisibility, setPinRing]);

  /* ---- Centroïde vivant d'une couche sélectionnée : le pivot d'orbite
     suit le barycentre de ses nœuds, qui bougent en permanence. ---- */
  const layerFollowGetter = useCallback((ids: Set<string>) => {
    return () => {
      const fg = fgRef.current;
      if (!fg) return null;
      let x = 0;
      let y = 0;
      let z = 0;
      let c = 0;
      for (const n of fg.graphData().nodes) {
        if (!ids.has(n.id) || typeof n.x !== "number") continue;
        x += n.x;
        y += n.y;
        z += n.z;
        c++;
      }
      return c > 0 ? new THREE.Vector3(x / c, y / c, z / c) : null;
    };
  }, []);

  /* ------- Sélection : surbrillance + la caméra orbite autour ------- */
  const applySelectionTarget = useCallback(() => {
    const { selectedId, selectedLinkKey } = stateRef.current;
    applyHighlight();
    const fg = fgRef.current;
    if (!fg) return;
    // Recentrer la cible d'orbite sur l'élément sélectionné (sans bouger la
    // caméra) : on enregistre un getter de position vivant, la boucle rAF le
    // suit en continu — le centrage tient donc aussi pendant les drags.
    let getPos: (() => THREE.Vector3 | null) | null = null;
    if (selectedId) {
      const n = fg.graphData().nodes.find((n: any) => n.id === selectedId);
      if (n)
        getPos = () =>
          typeof n.x === "number" ? new THREE.Vector3(n.x, n.y, n.z) : null;
    } else if (selectedLinkKey) {
      const l = fg.graphData().links.find((l: any) => l.key === selectedLinkKey);
      if (l)
        getPos = () =>
          typeof l.source?.x === "number" && typeof l.target?.x === "number"
            ? new THREE.Vector3(
                (l.source.x + l.target.x) / 2,
                (l.source.y + l.target.y) / 2,
                (l.source.z + l.target.z) / 2
              )
            : null;
    }
    if (getPos) {
      hadSelectionRef.current = true;
      followRef.current = { mode: "settle", last: null, getPos };
    } else if (hadSelectionRef.current) {
      followRef.current = null;
      // Une couche (ontologie) encore sélectionnée ? Le pivot revient sur
      // son centroïde plutôt que sur le centre global.
      const hl = stateRef.current.highlightIds as Set<string> | null;
      if (hl && hl.size > 0) {
        followRef.current = {
          mode: "settle",
          last: null,
          getPos: layerFollowGetter(hl),
        };
        return;
      }
      // Désélection : ramener le pivot d'orbite au centre du graphe visible,
      // sinon la rotation continue de tourner autour de l'ancienne sélection.
      hadSelectionRef.current = false;
      const { visibleNodeIds } = stateRef.current;
      const nodes = fg
        .graphData()
        .nodes.filter(
          (n: any) =>
            typeof n.x === "number" &&
            (!visibleNodeIds || visibleNodeIds.has(n.id))
        );
      const center = nodes.length
        ? {
            x: nodes.reduce((s: number, n: any) => s + n.x, 0) / nodes.length,
            y: nodes.reduce((s: number, n: any) => s + n.y, 0) / nodes.length,
            z: nodes.reduce((s: number, n: any) => s + n.z, 0) / nodes.length,
          }
        : { x: 0, y: 0, z: 0 };
      const p = fg.camera().position;
      fg.cameraPosition({ x: p.x, y: p.y, z: p.z }, center, 600);
    }
  }, [applyHighlight, layerFollowGetter]);

  /* ------- Données : mise à jour INCRÉMENTALE -------
     Nœuds et liens sont réutilisés par identité (cache par id/clé) : la lib
     ne recrée les objets three.js que pour les éléments réellement nouveaux
     (ex. couche d'ontologie importée) — ajouter une couche ne rebâtit donc
     jamais la scène, et positions comme sprites existants sont conservés. */
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const cache = nodeCacheRef.current;
    const linkCache = linkCacheRef.current;
    const nodeObjs = nodes.map((n) => {
      const existing = cache.get(n.id);
      const obj = existing ? Object.assign(existing, n) : { ...n };
      // Épinglages restaurés (session en cours ou sauvegarde « Save »)
      const pin = getPin("3d", n.id);
      if (pin && obj.__pinned !== true) {
        obj.x = pin[0];
        obj.y = pin[1];
        obj.z = pin[2];
        obj.fx = pin[0];
        obj.fy = pin[1];
        obj.fz = pin[2];
        obj.__pinned = true;
        setPinRing(n.id, true); // no-op si l'objet 3D n'existe pas encore
      }
      cache.set(n.id, obj);
      return obj;
    });
    const linkObjs = links.map((l) => {
      const key = l.key ?? `${l.source}|${l.target}|${l.label ?? ""}`;
      const existing = linkCache.get(key);
      const obj = existing ? Object.assign(existing, l) : { ...l };
      linkCache.set(key, obj);
      return obj;
    });
    // Purge des registres pour les éléments disparus (ontologie supprimée)
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const id of [...registryRef.current.keys()]) {
      if (!nodeIds.has(id)) registryRef.current.delete(id);
    }
    const linkKeys = new Set(links.map((l) => l.key));
    for (const k of [...linkSpriteRef.current.keys()]) {
      if (!linkKeys.has(k)) linkSpriteRef.current.delete(k);
    }
    fg.graphData({ nodes: nodeObjs, links: linkObjs });
    // Les mises à jour suivantes (lots du chargement progressif, couches) ne
    // doivent JAMAIS relancer de ticks de simulation synchrones : c'était la
    // source principale des gels (40 ticks × O(n) par lot).
    fg.warmupTicks(0);
    applySelectionTarget();
    // Les objets 3D (sphères/matériaux) sont créés de façon asynchrone après
    // graphData : si une sélection est déjà active (focus venu du chat), on
    // ré-applique l'estompage une fois les objets réellement en place.
    for (const ms of [400, 1200, 2500]) {
      setTimeout(() => {
        const { selectedId, selectedLinkKey } = stateRef.current;
        if (selectedId || selectedLinkKey) applyHighlight();
      }, ms);
    }
    if (firstFitRef.current && nodes.length > 0) {
      firstFitRef.current = false;
      // Fit initial SAUF si une sélection est déjà demandée (focus depuis le
      // chat) : sinon il écraserait le vol de caméra vers la sélection.
      fitTimerRef.current = setTimeout(() => {
        const { selectedId, selectedLinkKey } = stateRef.current;
        if (!selectedId && !selectedLinkKey) fg.zoomToFit(800, 60);
      }, 900);
    }
  }, [nodes, links, applySelectionTarget, setPinRing]);

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


  useEffect(() => {
    applySelectionTarget();
  }, [selectedId, selectedLinkKey, applySelectionTarget]);

  /* ------- Couche sélectionnée : estompage + orbite autour d'elle ------- */
  useEffect(() => {
    applyHighlight();
    const fg = fgRef.current;
    if (!fg) return;
    const { selectedId, selectedLinkKey } = stateRef.current;
    if (selectedId || selectedLinkKey) return; // la sélection de nœud prime
    if (highlightIds && highlightIds.size > 0) {
      hadSelectionRef.current = true;
      followRef.current = {
        mode: "settle",
        last: null,
        getPos: layerFollowGetter(highlightIds),
      };
    } else if (hadSelectionRef.current) {
      // Couche désélectionnée : retour au centre du graphe visible
      hadSelectionRef.current = false;
      followRef.current = null;
      const { visibleNodeIds } = stateRef.current;
      const nodes = fg
        .graphData()
        .nodes.filter(
          (n: any) =>
            typeof n.x === "number" &&
            (!visibleNodeIds || visibleNodeIds.has(n.id))
        );
      const center = nodes.length
        ? {
            x: nodes.reduce((s: number, n: any) => s + n.x, 0) / nodes.length,
            y: nodes.reduce((s: number, n: any) => s + n.y, 0) / nodes.length,
            z: nodes.reduce((s: number, n: any) => s + n.z, 0) / nodes.length,
          }
        : { x: 0, y: 0, z: 0 };
      const p = fg.camera().position;
      fg.cameraPosition({ x: p.x, y: p.y, z: p.z }, center, 600);
    }
  }, [highlightIds, applyHighlight, layerFollowGetter]);

  /* ------- Thème / couleurs ------- */
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.backgroundColor(dark ? "#0d0d0d" : "#f9f9f7");
    registryRef.current.forEach((entry, id) => {
      const node = nodeCacheRef.current.get(id);
      if (node) {
        (entry.mesh.material as THREE.MeshLambertMaterial).color.set(
          colorOf(node.group)
        );
      }
      if (entry.sprite) entry.sprite.color = dark ? "#c3c2b7" : "#52514e";
    });
    linkSpriteRef.current.forEach((entry) => {
      if (entry.sprite) entry.sprite.color = dark ? "#8fa8c8" : "#5b7ca6";
    });
    fg.linkColor(fg.linkColor());
  }, [dark, colorOf]);

  /* ------- API impérative ------- */
  useImperativeHandle(ref, () => ({
    focusNode(id: string) {
      const fg = fgRef.current;
      if (!fg) return false;
      const node = fg.graphData().nodes.find((n: any) => n.id === id);
      if (node && typeof node.x === "number") {
        if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
        const dist = 130;
        const norm = Math.hypot(node.x, node.y, node.z) || 1;
        const ratio = 1 + dist / norm;
        fg.cameraPosition(
          { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio },
          node,
          800
        );
        return true;
      }
      return false;
    },
    zoomToFit() {
      fgRef.current?.zoomToFit(800, 60);
    },
    resetPins() {
      const fg = fgRef.current;
      if (!fg) return;
      for (const n of fg.graphData().nodes) {
        if (n.__pinned) {
          n.__pinned = false;
          n.fx = undefined;
          n.fy = undefined;
          n.fz = undefined;
        }
      }
      registryRef.current.forEach((e) => {
        if (e.pin) e.pin.visible = false;
      });
    },
  }));

  /* ------- Alignement caméra sur un axe (gizmo) ------- */
  /* Alignement caméra : rotation sur la sphère autour du pivot (slerp),
     JAMAIS d'interpolation en ligne droite — une ligne droite entre deux
     points opposés traverserait le centre du graphe et ferait partir la
     vue en vrille. */
  const alignTo = (dir: [number, number, number]) => {
    const fg = fgRef.current;
    if (!fg) return;
    cancelAlign();
    const cam = fg.camera();
    const controls = fg.controls();
    const target: THREE.Vector3 =
      controls?.target?.clone() ?? new THREE.Vector3(0, 0, 0);
    const dist = cam.position.distanceTo(target) || 400;

    const start = cam.position.clone().sub(target).normalize();
    if (start.lengthSq() === 0) start.set(0, 0, 1);

    // ±Y = pôle d'OrbitControls : léger biais hors du pôle, dans l'azimut
    // courant (on monte/descend le long de son propre méridien).
    const end = new THREE.Vector3(...dir);
    if (Math.abs(end.y) > 0.99) {
      const h = new THREE.Vector3(start.x, 0, start.z);
      if (h.lengthSq() < 1e-4) h.set(0, 0, 1);
      h.normalize();
      end.set(h.x * 0.04, end.y, h.z * 0.04).normalize();
    }

    if (start.dot(end) > 0.999) return; // déjà aligné : ne rien faire

    // Interpolation en coordonnées SPHÉRIQUES (azimut/élévation), comme une
    // orbite à la souris : l'azimut tourne par le plus court chemin pendant
    // que l'élévation glisse vers la cible — jamais de passage par un pôle.
    // (Le slerp géodésique faisait claquer l'azimut — et donc tout le
    // repère — en quittant ou en traversant un pôle ; vérifié par
    // simulation : saut max/frame 2.0 → 0.17.)
    const sph0 = new THREE.Spherical().setFromVector3(start);
    const sph1 = new THREE.Spherical().setFromVector3(end);
    let dTheta = sph1.theta - sph0.theta;
    dTheta =
      ((((dTheta + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) -
      Math.PI;
    const dPhi = sph1.phi - sph0.phi;

    // Grands changements d'azimut depuis/vers un pôle : mélanger azimut et
    // inclinaison donne un tire-bouchon. On SÉQUENCE donc les deux phases :
    // partir d'un pôle = pivot à plat d'abord (vu de dessus, l'azimut est
    // une rotation à plat du graphe, lisible), puis descente en inclinaison
    // PURE le long du méridien cible — et l'inverse pour finir sur un pôle.
    const nearPole = (phi: number) => Math.min(phi, Math.PI - phi) < 0.5;
    let phased: "spin-first" | "spin-last" | null = null;
    if (Math.abs(dTheta) > 0.5) {
      if (nearPole(sph0.phi)) phased = "spin-first";
      else if (nearPole(sph1.phi)) phased = "spin-last";
    }
    const smooth = (r: number) => {
      const c = Math.min(1, Math.max(0, r));
      return c * c * (3 - 2 * c); // smoothstep
    };
    // Le pivot progresse sur le temps BRUT t (vitesse constante, non
    // amplifiée par l'ease-out) ; l'élévation garde l'ease-out. Les deux
    // phases se chevauchent à peine (fin de pivot ≈ début de descente).
    const thetaProg = (t: number, e: number) =>
      phased === "spin-first"
        ? smooth(t / 0.35)
        : phased === "spin-last"
          ? smooth((t - 0.65) / 0.35)
          : e;
    const phiProg = (e: number) =>
      phased === "spin-first"
        ? smooth((e - 0.5) / 0.5)
        : phased === "spin-last"
          ? smooth(e / 0.55)
          : e;

    const t0 = performance.now();
    // Durée proportionnelle à l'angle à pivoter (vitesse angulaire bornée)
    const DURATION = phased
      ? 600 + (700 * Math.abs(dTheta)) / Math.PI
      : 600;
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / DURATION);
      const e = t * (2 - t); // ease-out
      const d = new THREE.Vector3().setFromSpherical(
        new THREE.Spherical(
          1,
          sph0.phi + dPhi * phiProg(e),
          sph0.theta + dTheta * thetaProg(t, e)
        )
      );
      fg.cameraPosition(
        {
          x: target.x + d.x * dist,
          y: target.y + d.y * dist,
          z: target.z + d.z * dist,
        },
        { x: target.x, y: target.y, z: target.z },
        0
      );
      alignAnimRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    alignAnimRef.current = requestAnimationFrame(step);
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
    </div>
  );
});

export default NetworkCanvas3D;
