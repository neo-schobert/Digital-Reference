/**
 * Rendu des blocs ```diagram émis par le chatbot : un mini-langage
 * « Source (pref:Local) -> Target (pref:Local) : propriété », une arête par
 * ligne, transformé en SVG en couches (layout gauche → droite).
 *
 * Soins visuels :
 * - ordre des nœuds dans chaque couche par barycentre des voisins
 *   (minimise les croisements d'arêtes) ;
 * - labels d'arêtes répartis LE LONG de leur courbe (pas tous au milieu),
 *   posés sur une pastille opaque, avec résolution de collisions ;
 * - nœuds et arêtes cliquables (data-curie / data-efrom) → onglet Graph.
 */

interface DiagNode {
  id: string;
  label: string;
  curie?: string;
}

interface DiagEdge {
  from: string;
  to: string;
  label?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Les lignes arrivent déjà échappées HTML par renderMarkdown : on décode. */
function unesc(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function parseNode(s: string, nodes: Map<string, DiagNode>): string | null {
  const t = s.trim().replace(/^\*+|\*+$/g, "").trim();
  if (!t) return null;
  const m = t.match(/^(.*?)\s*\(([A-Za-z][\w.-]*:[\w][\w.-]*)\)\s*$/);
  const label = (m ? m[1] : t).trim() || t;
  const curie = m ? m[2] : undefined;
  const id = curie ?? label.toLowerCase();
  if (!nodes.has(id)) nodes.set(id, { id, label, curie });
  else if (curie && !nodes.get(id)!.curie) nodes.get(id)!.curie = curie;
  return id;
}

/** Point d'une Bézier cubique 1D à t. */
function bez(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

export function renderDiagram(rawLines: string[]): string {
  const nodes = new Map<string, DiagNode>();
  const edges: DiagEdge[] = [];
  for (const raw of rawLines) {
    const line = unesc(raw).trim();
    if (!line) continue;
    // Le séparateur de label est « : » ENTOURÉ d'espaces — un deux-points
    // collé appartient à un CURIE (prefix:Local), pas au label.
    const m = line.match(/^(.+?)\s*(?:->|→|—+>)\s*(.+?)(?:\s+:\s+(.+))?$/);
    if (!m) continue;
    const from = parseNode(m[1], nodes);
    const to = parseNode(m[2], nodes);
    if (!from || !to || from === to) continue;
    edges.push({
      from,
      to,
      label: m[3]?.replace(/^\*+|\*+$/g, "").trim() || undefined,
    });
  }
  if (edges.length === 0) return "";

  /* ---- Couches : plus long chemin depuis les racines (cycles bornés) ---- */
  const layer = new Map<string, number>();
  for (const id of nodes.keys()) layer.set(id, 0);
  for (let i = 0; i < nodes.size; i++) {
    let changed = false;
    for (const e of edges) {
      const want = layer.get(e.from)! + 1;
      if (layer.get(e.to)! < want && want < nodes.size + 1) {
        layer.set(e.to, want);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const maxLayer = Math.max(...layer.values());
  const byLayer: DiagNode[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes.values()) byLayer[layer.get(n.id)!].push(n);

  /* ---- Ordre vertical : barycentre des voisins (réduit les croisements) --- */
  const order = new Map<string, number>();
  const appear = [...nodes.keys()];
  byLayer.forEach((list) => {
    list.sort((a, b) => appear.indexOf(a.id) - appear.indexOf(b.id));
    list.forEach((n, i) => order.set(n.id, i));
  });
  const neigh = new Map<string, string[]>();
  for (const e of edges) {
    if (!neigh.has(e.from)) neigh.set(e.from, []);
    if (!neigh.has(e.to)) neigh.set(e.to, []);
    neigh.get(e.from)!.push(e.to);
    neigh.get(e.to)!.push(e.from);
  }
  for (let pass = 0; pass < 3; pass++) {
    for (const list of byLayer) {
      const bary = (n: DiagNode) => {
        const ns = neigh.get(n.id) ?? [];
        if (ns.length === 0) return order.get(n.id)!;
        return ns.reduce((s, id) => s + (order.get(id) ?? 0), 0) / ns.length;
      };
      list.sort((a, b) => bary(a) - bary(b) || appear.indexOf(a.id) - appear.indexOf(b.id));
      list.forEach((n, i) => order.set(n.id, i));
    }
  }

  /* ---- Géométrie ---- */
  const CHAR = 6.6;
  const PADX = 14;
  const BOXH = 34;
  const VGAP = 26;
  // L'espace inter-colonnes s'adapte au plus long label d'arête : les
  // pastilles doivent pouvoir s'étaler horizontalement le long des courbes.
  const longestLabel = Math.max(0, ...edges.map((e) => e.label?.length ?? 0));
  const HGAP = Math.min(260, Math.max(130, longestLabel * 5.4 + 50));
  const PAD = 14;
  const widthOf = (n: DiagNode) =>
    Math.max(64, Math.round(n.label.length * CHAR) + PADX * 2);

  const colW = byLayer.map((list) => Math.max(...list.map(widthOf), 64));
  const colX: number[] = [];
  let x = PAD;
  for (let l = 0; l <= maxLayer; l++) {
    colX.push(x);
    x += colW[l] + HGAP;
  }
  const W = x - HGAP + PAD;
  const innerH = Math.max(
    ...byLayer.map((list) => list.length * (BOXH + VGAP) - VGAP)
  );
  const H = innerH + PAD * 2 + 10;

  const pos = new Map<string, { x: number; y: number; w: number }>();
  byLayer.forEach((list, l) => {
    const layerH = list.length * (BOXH + VGAP) - VGAP;
    const y0 = PAD + 5 + (innerH - layerH) / 2;
    list.forEach((n, i) => {
      const w = widthOf(n);
      pos.set(n.id, {
        x: colX[l] + (colW[l] - w) / 2,
        y: y0 + i * (BOXH + VGAP),
        w,
      });
    });
  });

  /* ---- SVG ---- */
  const parts: string[] = [];
  parts.push(
    `<svg class="diagram" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">`
  );
  parts.push(
    `<defs><marker id="diag-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="diag-arrowhead"/></marker></defs>`
  );

  // Positions des labels : réparties le long de la courbe, puis résolution de
  // collisions entre pastilles.
  const T_SLOTS = [0.5, 0.34, 0.66, 0.26, 0.74, 0.42, 0.58];
  const placed: { x: number; y: number; w: number }[] = [
    // Les boîtes des nœuds comptent comme obstacles
    ...[...nodes.values()].map((n) => {
      const p = pos.get(n.id)!;
      return { x: p.x + p.w / 2, y: p.y + BOXH / 2, w: p.w + 8 };
    }),
  ];

  edges.forEach((e, ei) => {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    const na = nodes.get(e.from)!;
    const nb = nodes.get(e.to)!;
    const back = layer.get(e.from)! >= layer.get(e.to)!;
    const x1 = back ? a.x : a.x + a.w;
    const y1 = a.y + BOXH / 2;
    const x2 = back ? b.x + b.w : b.x;
    const y2 = b.y + BOXH / 2;
    const dx = Math.max(36, Math.abs(x2 - x1) / 2.4);
    const c1 = back ? x1 - dx : x1 + dx;
    const c2 = back ? x2 + dx : x2 - dx;

    const attrs =
      na.curie && nb.curie
        ? ` class="diag-edge clickable" data-efrom="${esc(na.curie)}" data-eto="${esc(nb.curie)}"${e.label ? ` data-evia="${esc(e.label)}"` : ""}`
        : ` class="diag-edge"`;
    parts.push(`<g${attrs}>`);
    parts.push(
      `<path d="M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}" fill="none" marker-end="url(#diag-arrow)"/>`
    );

    if (e.label) {
      const lw = Math.max(40, e.label.length * 5.4 + 12);
      // essayer plusieurs positions t le long de la courbe, garder la première
      // sans collision (sinon la moins mauvaise, décalée verticalement)
      let best: { x: number; y: number } | null = null;
      for (const t of T_SLOTS.slice(ei % 2, T_SLOTS.length)) {
        const lx = bez(t, x1, c1, c2, x2);
        const ly = bez(t, y1, y1, y2, y2);
        const hit = placed.some(
          (p) => Math.abs(p.x - lx) < (p.w + lw) / 2 && Math.abs(p.y - ly) < 18
        );
        if (!hit) {
          best = { x: lx, y: ly };
          break;
        }
        if (!best) best = { x: lx, y: ly };
      }
      if (best) {
        // dernier recours : essayer des décalages verticaux fixes depuis la
        // position de base, prendre le premier libre
        const collides = (y: number) =>
          placed.some(
            (p) => Math.abs(p.x - best!.x) < (p.w + lw) / 2 && Math.abs(p.y - y) < 20
          );
        for (const off of [0, -20, 20, -40, 40, -60, 60, -80, 80]) {
          if (!collides(best.y + off)) {
            best.y += off;
            break;
          }
        }
        placed.push({ x: best.x, y: best.y, w: lw });
        parts.push(
          `<g class="diag-pill"><rect x="${best.x - lw / 2}" y="${best.y - 9}" width="${lw}" height="18" rx="9"/>` +
            `<text x="${best.x}" y="${best.y + 3.5}" text-anchor="middle" class="diag-elabel">${esc(e.label)}</text></g>`
        );
      }
    }
    parts.push(`</g>`);
  });

  // Boîtes (au-dessus des arêtes)
  for (const n of nodes.values()) {
    const p = pos.get(n.id)!;
    const attrs = n.curie
      ? ` class="diag-node clickable" data-curie="${esc(n.curie)}"`
      : ` class="diag-node"`;
    parts.push(`<g${attrs}>`);
    parts.push(
      `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${BOXH}" rx="9"/>`
    );
    parts.push(
      `<text x="${p.x + p.w / 2}" y="${p.y + BOXH / 2 + 4}" text-anchor="middle">${esc(n.label)}</text>`
    );
    if (n.curie) parts.push(`<title>${esc(n.curie)} — show in the graph</title>`);
    parts.push(`</g>`);
  }

  parts.push(`</svg>`);
  return `<div class="diagram-wrap">${parts.join("")}</div>`;
}
