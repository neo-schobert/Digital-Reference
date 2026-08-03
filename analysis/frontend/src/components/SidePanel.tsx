/*
 * Panneau latéral repliable et redimensionnable.
 *
 * - Une poignée sur le bord intérieur : on attrape le côté de la fenêtre et
 *   on tire pour élargir / rétrécir (souris, tactile, ou flèches au clavier).
 * - Un bouton « replier » en bas à gauche du panneau ; replié, il ne reste
 *   qu'un rail vertical cliquable qui porte le nom du panneau.
 * - Tirer la poignée au-delà de la largeur minimale replie aussi le panneau,
 *   et tirer le rail vers l'extérieur le rouvre.
 * - Largeur et état replié sont mémorisés par panneau dans localStorage.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const STORAGE_KEY = "dr-side-panels";

/** Largeur du rail quand le panneau est replié (doit suivre le CSS). */
const RAIL_WIDTH = 30;

/** Marge de tirage en deçà du minimum avant que le panneau ne se replie. */
const COLLAPSE_SLACK = 44;

type Side = "left" | "right";

type PanelState = { width: number; collapsed: boolean };

function loadAll(): Record<string, PanelState> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return typeof raw === "object" && raw !== null ? raw : {};
  } catch {
    return {};
  }
}

function persist(id: string, state: PanelState): void {
  try {
    const all = loadAll();
    all[id] = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota plein ou stockage refusé : la mise en page reste utilisable */
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface SidePanelProps {
  /** Clé de persistance (unique par panneau de l'application). */
  id: string;
  side: Side;
  /** Libellé affiché sur le rail une fois replié. */
  title: string;
  defaultWidth: number;
  min?: number;
  max?: number;
  /** Classe du conteneur défilant (les styles existants du panneau). */
  className?: string;
  children: ReactNode;
}

export default function SidePanel({
  id,
  side,
  title,
  defaultWidth,
  min = 180,
  max = 560,
  className,
  children,
}: SidePanelProps) {
  const [width, setWidth] = useState(() =>
    clamp(loadAll()[id]?.width ?? defaultWidth, min, max)
  );
  const [collapsed, setCollapsed] = useState(() => loadAll()[id]?.collapsed ?? false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    persist(id, { width, collapsed });
  }, [id, width, collapsed]);

  // Le geste est suivi en ref : le pointer capture nous garantit de recevoir
  // move/up même si le curseur passe au-dessus du canvas WebGL.
  const drag = useRef<{ x: number; w: number } | null>(null);

  const applyDrag = useCallback(
    (clientX: number) => {
      const start = drag.current;
      if (!start) return;
      const delta = side === "left" ? clientX - start.x : start.x - clientX;
      const raw = start.w + delta;
      if (raw < min - COLLAPSE_SLACK) {
        setCollapsed(true);
      } else {
        setCollapsed(false);
        setWidth(clamp(raw, min, max));
      }
    },
    [side, min, max]
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { x: e.clientX, w: collapsed ? RAIL_WIDTH : width };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current) applyDrag(e.clientX);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // Pendant le tirage, tout le document adopte le curseur de redimensionnement
  // et perd la sélection de texte : sinon le survol des panneaux le reprend.
  useEffect(() => {
    if (!dragging) return;
    const body = document.body;
    const prevCursor = body.style.cursor;
    const prevSelect = body.style.userSelect;
    body.style.cursor = "col-resize";
    body.style.userSelect = "none";
    return () => {
      body.style.cursor = prevCursor;
      body.style.userSelect = prevSelect;
    };
  }, [dragging]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    if (e.key === grow) {
      e.preventDefault();
      if (collapsed) setCollapsed(false);
      else setWidth((w) => clamp(w + step, min, max));
    } else if (e.key === shrink) {
      e.preventDefault();
      if (!collapsed && width - step < min) setCollapsed(true);
      else if (!collapsed) setWidth((w) => clamp(w - step, min, max));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setCollapsed((c) => !c);
    }
  };

  const chevron = side === "left" ? "‹" : "›";
  const openChevron = side === "left" ? "›" : "‹";

  return (
    <div
      className={`side-panel ${side}${collapsed ? " collapsed" : ""}${
        dragging ? " dragging" : ""
      }`}
      style={{ width: collapsed ? RAIL_WIDTH : width }}
    >
      {collapsed ? (
        <button
          className="panel-rail"
          onClick={() => setCollapsed(false)}
          title={`Expand ${title}`}
          aria-label={`Expand ${title}`}
        >
          <span className="rail-label">{title}</span>
          <span className="rail-chevron">{openChevron}</span>
        </button>
      ) : (
        <>
          <div className={`panel-content${className ? ` ${className}` : ""}`}>
            {children}
          </div>
          <div className="panel-foot">
            <button
              className="panel-toggle"
              onClick={() => setCollapsed(true)}
              title={`Collapse ${title}`}
              aria-label={`Collapse ${title}`}
            >
              <span className="toggle-chevron">{chevron}</span>
              Collapse
            </button>
          </div>
        </>
      )}
      <div
        className="panel-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${title}`}
        aria-valuenow={collapsed ? 0 : width}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={() => {
          setCollapsed(false);
          setWidth(clamp(defaultWidth, min, max));
        }}
      />
    </div>
  );
}
