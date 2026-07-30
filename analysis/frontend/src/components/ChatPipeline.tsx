import { useEffect, useRef, useState } from "react";
import type { ChatCitation, ChatTrace, TraceCandidate } from "../types";
import type { GraphFocusRequest as PeekTarget } from "../bus";

/**
 * Visualisation pédagogique du pipeline GraphRAG.
 * - Live : les panneaux s'empilent au fur et à mesure (le raisonnement se
 *   construit sous les yeux de l'utilisateur).
 * - Revue : TOUS les panneaux restent développés, empilés dans l'ordre du
 *   pipeline, la réponse arrive à la fin, puis les sources. Chaque puce du
 *   rail replie/déplie son panneau.
 *
 * Le panneau « Vector search » explique le mécanisme : nuage des ~2100
 * concepts vectorisés, balayage de comparaison, puis les concepts les plus
 * proches s'envolent vers un classement à droite (score sémantique+lexical).
 */

interface Props {
  trace: ChatTrace;
  activeStage: string | null;
  live: boolean;
  citations?: ChatCitation[];
  answerHtml?: string;
  sparqlFailed?: boolean;
  question?: string;
  /** Ouvre l'aperçu graphe sur un nœud ou une relation mentionnés */
  onPeek?: (t: PeekTarget) => void;
  /** Résout « prefix:Local » vers l'IRI complet (préfixes du /api/meta) */
  resolveIri?: (prefixed: string) => string | null;
}

const STEP_META: Record<string, { label: string; icon: string }> = {
  embed: { label: "Vectorize", icon: "⚡" },
  retrieve: { label: "Vector search", icon: "🔍" },
  route: { label: "Route", icon: "🧭" },
  sparql: { label: "SPARQL", icon: "🛢️" },
  graph: { label: "Graph tool", icon: "🕸️" },
  answer: { label: "Answer", icon: "✍️" },
  sources: { label: "Sources", icon: "📚" },
};

function isDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  if (forced === "dark") return true;
  if (forced === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function cellColor(v: number): string {
  const a = Math.min(1, Math.abs(v) / 0.12);
  return v >= 0
    ? `rgba(42, 120, 214, ${0.15 + 0.85 * a})`
    : `rgba(224, 122, 54, ${0.15 + 0.85 * a})`;
}

function hashIri(iri: string): number {
  let h = 2166136261;
  for (let i = 0; i < iri.length; i++) {
    h ^= iri.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/* ------------------------------------------------------------------ */
/* Canvas : nuage vectoriel → scan → envol des élus vers le classement */
/* ------------------------------------------------------------------ */

function VectorField({
  total,
  candidates,
  searching,
}: {
  total: number;
  candidates: TraceCandidate[];
  searching: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({ candidates, searching, total });
  stateRef.current = { candidates, searching, total };
  const startRef = useRef(performance.now());
  const foundAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!searching && candidates.length > 0 && foundAtRef.current === null) {
      foundAtRef.current = performance.now();
    }
  }, [searching, candidates]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = cv.clientWidth || cv.parentElement?.clientWidth || 640;
    const H = 300;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = W * dpr;
    cv.height = H * dpr;
    ctx.scale(dpr, dpr);

    const COL_W = Math.min(250, W * 0.42); // colonne de classement à droite
    const cloudCx = (W - COL_W) / 2;
    const cloudCy = H / 2;
    const N = Math.max(200, Math.min(stateRef.current.total || 2000, 2600));
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    const maxR = Math.min(W - COL_W, H) / 2 - 14;
    const posOf = (i: number): [number, number] => {
      const r = 16 + (maxR - 16) * Math.sqrt((i + 0.5) / N);
      const a = i * GOLDEN;
      return [cloudCx + r * Math.cos(a), cloudCy + r * Math.sin(a) * 0.94];
    };

    let raf = 0;
    const draw = () => {
      const { candidates, searching } = stateRef.current;
      const dark = isDark();
      const t = (performance.now() - startRef.current) / 1000;
      ctx.clearRect(0, 0, W, H);

      const textCol = dark ? "#d8d7cc" : "#3a3936";
      const mutedCol = dark ? "#8f8d85" : "#898781";

      // -- 1. le nuage : chaque concept déjà vectorisé, teinté par module
      const reveal = Math.min(1, t / 1.0);
      const shown = Math.floor(N * reveal);
      for (let i = 0; i < shown; i++) {
        const [x, y] = posOf(i);
        const hue = (i * 47) % 360;
        ctx.fillStyle = `hsla(${hue}, 40%, ${dark ? 62 : 45}%, 0.30)`;
        ctx.fillRect(x, y, 2, 2);
      }
      ctx.fillStyle = mutedCol;
      ctx.font = "10.5px system-ui";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(`${stateRef.current.total} concept vectors`, 8, H - 8);

      // -- 2. balayage radar pendant la comparaison
      if (searching || reveal < 1) {
        const ang = (t * 2.4) % (Math.PI * 2);
        if (typeof (ctx as any).createConicGradient === "function") {
          const grad = (ctx as any).createConicGradient(ang, cloudCx, cloudCy);
          grad.addColorStop(0, "rgba(42,120,214,0.30)");
          grad.addColorStop(0.15, "rgba(42,120,214,0)");
          grad.addColorStop(1, "rgba(42,120,214,0)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(cloudCx, cloudCy, maxR + 6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = mutedCol;
        ctx.textAlign = "center";
        ctx.fillText("comparing (cosine similarity)…", cloudCx, 14);
      }

      // -- 3. la question, au centre du nuage
      const qPulse = 1 + 0.12 * Math.sin(t * 3);
      ctx.beginPath();
      ctx.arc(cloudCx, cloudCy, 9 * qPulse, 0, Math.PI * 2);
      ctx.fillStyle = "#2a78d6";
      ctx.fill();
      ctx.strokeStyle = "rgba(42,120,214,0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cloudCx, cloudCy, 14 * qPulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 9px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Q", cloudCx, cloudCy + 0.5);

      // -- 4. les élus s'envolent du nuage vers le classement à droite
      if (!searching && candidates.length > 0) {
        const since = foundAtRef.current
          ? (performance.now() - foundAtRef.current) / 1000
          : 99;
        const top = candidates.slice(0, 10);
        const maxScore = Math.max(...top.map((c) => c.score), 1e-6);
        const slotX = W - COL_W + 14;
        const rowH = Math.min(28, (H - 30) / top.length);

        // titre de colonne
        ctx.fillStyle = mutedCol;
        ctx.font = "600 10px system-ui";
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillText("SELECTED & RANKED", slotX, 14);

        for (let j = 0; j < top.length; j++) {
          const c = top[j];
          const p = easeOut(Math.max(0, Math.min(1, (since - j * 0.14) / 0.6)));
          if (p <= 0) continue;
          const idx = hashIri(c.iri) % N;
          const [sx, sy] = posOf(idx);
          const ty = 26 + j * rowH;
          const x = sx + (slotX + 4 - sx) * p;
          const y = sy + (ty + 6 - sy) * p;
          const w = c.score / maxScore;

          // trace de similarité : Q -> position courante
          ctx.beginPath();
          ctx.moveTo(cloudCx, cloudCy);
          ctx.lineTo(x, y);
          ctx.strokeStyle = `rgba(42,120,214,${(0.10 + 0.3 * w) * p})`;
          ctx.lineWidth = 0.5 + 1.6 * w;
          ctx.stroke();

          // point d'origine fantôme dans le nuage
          ctx.beginPath();
          ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(42,120,214,0.35)";
          ctx.fill();

          // le nœud en vol / arrivé
          const r = 3 + 3.5 * w;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(42,120,214,${0.5 + 0.5 * w})`;
          ctx.fill();

          // une fois arrivé : libellé + barre segmentée + score
          if (p > 0.85) {
            const alpha = (p - 0.85) / 0.15;
            ctx.globalAlpha = alpha;
            const label = c.label.length > 21 ? c.label.slice(0, 19) + "…" : c.label;
            ctx.fillStyle = textCol;
            ctx.font = "600 11px system-ui";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(label, slotX + 14, ty + 2);
            ctx.fillStyle = mutedCol;
            ctx.font = "10px system-ui";
            ctx.textAlign = "right";
            ctx.fillText(c.score.toFixed(3), W - 10, ty + 2);
            // barre : part sémantique (bleu) + part lexicale (vert)
            const barX = slotX + 14;
            const barW = COL_W - 46;
            const semW = barW * ((0.65 * c.sem) / maxScore);
            const lexW = barW * ((0.35 * c.lex) / maxScore);
            ctx.fillStyle = dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
            ctx.fillRect(barX, ty + 9, barW, 5);
            ctx.fillStyle = "#2a78d6";
            ctx.fillRect(barX, ty + 9, semW, 5);
            ctx.fillStyle = "#2fa146";
            ctx.fillRect(barX + semW, ty + 9, lexW, 5);
            ctx.globalAlpha = 1;
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} className="vec-field" />;
}

/* ------------------------------------------------------------------ */
/* SPARQL : machine à écrire (live) et coloration (revue)              */
/* ------------------------------------------------------------------ */

function highlightSparql(query: string): string {
  const esc = query
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .replace(
      /\b(SELECT|ASK|WHERE|FILTER|OPTIONAL|UNION|DISTINCT|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|COUNT|DESC|ASC|PREFIX|AS|STRSTARTS|STR|isIRI|isLiteral)\b/g,
      '<span class="sq-kw">$1</span>'
    )
    .replace(/(\?[A-Za-z_][A-Za-z0-9_]*)/g, '<span class="sq-var">$1</span>');
}

function TypeWriter({ text, animate }: { text: string; animate: boolean }) {
  const [n, setN] = useState(animate ? 0 : text.length);
  useEffect(() => {
    if (!animate) {
      setN(text.length);
      return;
    }
    setN(0);
    const iv = setInterval(() => {
      setN((v) => {
        if (v >= text.length) {
          clearInterval(iv);
          return v;
        }
        return v + 4;
      });
    }, 14);
    return () => clearInterval(iv);
  }, [text, animate]);
  if (n >= text.length) {
    return <pre dangerouslySetInnerHTML={{ __html: highlightSparql(text) }} />;
  }
  return (
    <pre>
      {text.slice(0, n)}
      <span className="tw-caret" />
    </pre>
  );
}

/* ------------------------------------------------------------------ */
/* Graph tool : chaînes de nœuds et classements en barres              */
/* ------------------------------------------------------------------ */

function GraphToolView({
  tool,
  detail,
  onPeek,
  resolveIri,
}: {
  tool: string;
  detail?: string;
  onPeek?: (t: PeekTarget) => void;
  resolveIri?: (prefixed: string) => string | null;
}) {
  if (!detail)
    return <div className="pipe-note">Running exhaustive graph computation…</div>;
  const lines = detail.split("\n");
  const [summary, ...rest] = lines;
  const iriIn = (s: string): string | null => {
    const m = s.match(/\(([A-Za-z][\w.-]*:[\w][\w.-]*)\)/);
    return m && resolveIri ? resolveIri(m[1]) : null;
  };

  if (tool === "longest_chain" || tool === "shortest_path") {
    const iris = rest.map(iriIn);
    return (
      <>
        <div className="pipe-note">{summary}</div>
        <div className="chain-flow">
          {rest.map((s, i) => {
            const label = s.replace(/^\s*(→ subclass:|—\[.*?\]→)\s*/, "");
            const via = s.match(/—\[(.*?)\]→/)?.[1];
            const iri = iris[i];
            const prev = i > 0 ? iris[i - 1] : null;
            return (
              <div key={i} className="chain-step" style={{ animationDelay: `${i * 150}ms` }}>
                {i > 0 && (
                  <div
                    className={`chain-link${prev && iri && onPeek ? " clickable" : ""}`}
                    onClick={() =>
                      prev && iri && onPeek?.({ from: iri, to: prev, via: via ?? "subClassOf" })
                    }
                    title={prev && iri ? "Show this relation in the graph" : undefined}
                  >
                    ↓ <em>{via ?? "subClassOf"}</em>
                  </div>
                )}
                <div
                  className={`chain-node${iri && onPeek ? " clickable" : ""}`}
                  onClick={() => iri && onPeek?.({ iri })}
                  title={iri ? "Show this class in the graph" : undefined}
                >
                  {label}
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  // Classements (top_subclasses, top_degree) : barres proportionnelles
  const rows = rest
    .map((l) => l.match(/^(\d+)\.\s+(.*?)\s+—\s+(?:degree\s+)?(\d+)/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ rank: m[1], label: m[2], value: Number(m[3]) }));
  if (rows.length === 0)
    return (
      <>
        <div className="pipe-note">{summary}</div>
        <pre className="graph-detail">{rest.join("\n")}</pre>
      </>
    );
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <>
      <div className="pipe-note">{summary}</div>
      {rows.map((r, i) => {
        const iri = iriIn(r.label);
        return (
        <div
          key={i}
          className={`rank-row${iri && onPeek ? " clickable" : ""}`}
          style={{ animationDelay: `${i * 100}ms` }}
          onClick={() => iri && onPeek?.({ iri })}
          title={iri ? "Show this class in the graph" : undefined}
        >
          <span className="rank-pos">{r.rank}</span>
          <span className="rank-label">{r.label.replace(/\s*\(.*\)$/, "")}</span>
          <span className="rank-track">
            <span className="rank-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="rank-value">{r.value}</span>
        </div>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Panneaux                                                            */
/* ------------------------------------------------------------------ */

function StagePanel({
  step,
  trace,
  live,
  activeStage,
  citations,
  answerHtml,
  sparqlFailed,
  question,
  onPeek,
  resolveIri,
}: {
  step: string;
  trace: ChatTrace;
  live: boolean;
  activeStage: string | null;
  citations?: ChatCitation[];
  answerHtml?: string;
  sparqlFailed?: boolean;
  question?: string;
  onPeek?: (t: PeekTarget) => void;
  resolveIri?: (prefixed: string) => string | null;
}) {
  if (step === "embed") {
    if (!trace.embed && !live) return null;
    return (
      <div className="pipe-panel">
        <div className="pipe-title">⚡ Vectorize — the question becomes a vector</div>
        {trace.rewrite && (
          <div className="rewrite-note">
            ↪ follow-up interpreted as: <em>“{trace.rewrite.standalone}”</em>
          </div>
        )}
        {!trace.embed ? (
          <div className="pipe-note">Encoding the question…</div>
        ) : trace.embed.error ? (
          <div className="pipe-note">Embeddings unavailable — lexical retrieval only.</div>
        ) : (
          <div className="embed-flow">
            <div className="embed-q">“{question ?? "question"}”</div>
            <div className="embed-arrow">⟶</div>
            <div>
              <div className="vec-cells">
                {trace.embed.preview.map((v, i) => (
                  <span
                    key={i}
                    className="vec-cell"
                    style={{ background: cellColor(v), animationDelay: `${i * 22}ms` }}
                    title={`dim ${i}: ${v.toFixed(4)}`}
                  />
                ))}
              </div>
              <div className="pipe-note" style={{ marginTop: 5, marginBottom: 0 }}>
                {trace.embed.dims} dimensions (first 48 shown) · {trace.embed.tookMs} ms ·{" "}
                <span className="dot" style={{ background: "rgba(42,120,214,.9)" }} /> positive{" "}
                <span className="dot" style={{ background: "rgba(224,122,54,.9)" }} /> negative
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (step === "retrieve") {
    const searching = live && !trace.retrieval;
    const cands = trace.retrieval?.candidates ?? [];
    return (
      <div className="pipe-panel">
        <div className="pipe-title">
          🔍 Vector search — the closest concepts are selected
        </div>
        <div className="how-steps">
          <span>
            <b>1</b> every ontology concept was embedded once (
            {trace.retrieval?.total ?? "≈2100"} vectors)
          </span>
          <span>
            <b>2</b> the question vector Q is compared to all of them
          </span>
          <span>
            <b>3</b> the nearest ones are kept &amp; ranked
          </span>
        </div>
        <VectorField
          total={trace.retrieval?.total ?? 2106}
          candidates={cands}
          searching={searching}
        />
        <div className="pipe-legend">
          <span>
            <span className="dot" style={{ background: "var(--accent)" }} />
            semantic similarity (65%)
          </span>
          <span>
            <span className="dot" style={{ background: "#2fa146" }} />
            lexical overlap (35%)
          </span>
          {trace.retrieval && (
            <span>compared in {trace.retrieval.tookMs} ms</span>
          )}
        </div>
      </div>
    );
  }

  if (step === "route") {
    if (!trace.route && !live) return null;
    const routes: { key: string; title: string; desc: string }[] = [
      { key: "lookup", title: "lookup", desc: "answer from concept descriptions" },
      { key: "structural", title: "structural", desc: "generate & run a SPARQL query" },
      { key: "graph", title: "graph", desc: "exact graph algorithm (paths, rankings)" },
    ];
    return (
      <div className="pipe-panel">
        <div className="pipe-title">🧭 Route — how should this question be answered?</div>
        {!trace.route ? (
          <div className="pipe-note">Classifying the question…</div>
        ) : (
          <div className="route-cards">
            {routes.map((r) => (
              <div
                key={r.key}
                className={`route-card${trace.route === r.key ? " chosen" : ""}`}
              >
                <div className="route-card-title">
                  {trace.route === r.key ? "✓ " : ""}
                  {r.title}
                </div>
                <div className="route-card-desc">{r.desc}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (step === "sparql") {
    if (trace.sparqlAttempts.length === 0 && activeStage !== "sparql") return null;
    return (
      <div className="pipe-panel">
        <div className="pipe-title">🛢️ SPARQL — querying the ontology</div>
        {trace.sparqlAttempts.length === 0 && (
          <div className="pipe-note">Generating the query…</div>
        )}
        {trace.sparqlAttempts.map((a, i) => (
          <div key={a.attempt} className="sparql-attempt">
            <div className="att-head">
              Attempt {a.attempt}{" "}
              {a.ok === true && (
                <span className="att-ok">
                  ✓ {a.rows} row{a.rows === 1 ? "" : "s"}
                </span>
              )}
              {a.ok === false && <span className="att-err">✗ {a.error}</span>}
              {a.ok === undefined && live && <span>… executing</span>}
            </div>
            <TypeWriter
              text={a.query}
              animate={live && i === trace.sparqlAttempts.length - 1}
            />
          </div>
        ))}
      </div>
    );
  }

  if (step === "graph") {
    if (!trace.graph && activeStage !== "graph") return null;
    return (
      <div className="pipe-panel">
        <div className="pipe-title">
          🕸️ Graph tool — <code>{trace.graph?.tool ?? "…"}</code> (exact, exhaustive)
        </div>
        <GraphToolView
          tool={trace.graph?.tool ?? "…"}
          detail={trace.graph?.detail}
          onPeek={onPeek}
          resolveIri={resolveIri}
        />
      </div>
    );
  }

  if (step === "answer") {
    if (live) {
      return (
        <div className="pipe-panel">
          <div className="pipe-title">✍️ Answer</div>
          <span className="typing-dots">
            <span />
            <span />
            <span />
          </span>
          <span className="pipe-note" style={{ marginLeft: 8, display: "inline" }}>
            Writing the grounded answer…
          </span>
        </div>
      );
    }
    if (!answerHtml) return null;
    return (
      <div className="pipe-panel answer-panel">
        <div className="pipe-title">✍️ Answer</div>
        {sparqlFailed && (
          <div className="sparql-failed-note">
            ⚠️ The structural SPARQL query could not be executed — this answer
            relies on retrieved concept descriptions only.
          </div>
        )}
        <div
          onClick={(e) => {
            const el = (e.target as Element).closest(
              "[data-iri],[data-curie],[data-efrom]"
            ) as HTMLElement | SVGElement | null;
            if (!el || !onPeek) return;
            const d = (el as HTMLElement).dataset;
            if (d.iri) {
              onPeek({ iri: d.iri });
            } else if (d.curie) {
              const iri = resolveIri?.(d.curie);
              if (iri) onPeek({ iri });
            } else if (d.efrom && d.eto) {
              const from = resolveIri?.(d.efrom);
              const to = resolveIri?.(d.eto);
              if (from && to) onPeek({ from, to, via: d.evia || undefined });
            }
          }}
          dangerouslySetInnerHTML={{ __html: answerHtml }}
        />
      </div>
    );
  }

  if (step === "sources") {
    if (!citations || citations.length === 0) return null;
    return (
      <div className="pipe-panel">
        <div className="pipe-title">📚 Sources — ontology concepts used</div>
        <div className="chat-citations" style={{ marginTop: 4 }}>
          {citations.map((c) => (
            <span
              key={c.iri}
              className={`chat-chip${onPeek ? " clickable" : ""}`}
              title={`${c.iri} — click to show in the graph`}
              onClick={() => onPeek?.({ iri: c.iri })}
            >
              {c.label}
              <span className="chip-module">{c.module}</span>
            </span>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Composant principal                                                 */
/* ------------------------------------------------------------------ */

export default function ChatPipeline({
  trace,
  activeStage,
  live,
  citations,
  answerHtml,
  sparqlFailed,
  question,
  onPeek,
  resolveIri,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const showSparql = trace.sparqlAttempts.length > 0 || (live && activeStage === "sparql");
  const showGraph = !!trace.graph || (live && activeStage === "graph");
  const steps = [
    "embed",
    "retrieve",
    "route",
    ...(showSparql ? ["sparql"] : []),
    ...(showGraph ? ["graph"] : []),
    "answer",
    ...(!live && citations && citations.length > 0 ? ["sources"] : []),
  ];

  const hasData = (key: string): boolean => {
    switch (key) {
      case "embed":
        return !!trace.embed;
      case "retrieve":
        return !!trace.retrieval;
      case "route":
        return !!trace.route;
      case "sparql":
        return trace.sparqlAttempts.length > 0;
      case "graph":
        return !!trace.graph;
      case "answer":
      case "sources":
        return !live;
      default:
        return false;
    }
  };

  const statusOf = (key: string): string => {
    if (live) {
      if (key === activeStage) return "active";
      return hasData(key) ? "done" : "pending";
    }
    return collapsed.has(key) ? "done" : "done selected";
  };

  const toggle = (key: string) => {
    if (live) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Live : panneaux atteints, dans l'ordre. Revue : tous, sauf repliés.
  const reachedIdx = live
    ? Math.max(
        steps.indexOf(activeStage ?? "embed"),
        ...steps.map((s, i) => (hasData(s) ? i : -1))
      )
    : steps.length - 1;
  const visible = steps
    .slice(0, reachedIdx + 1)
    .filter((s) => live || !collapsed.has(s));

  return (
    <div className="pipe">
      <div className="pipe-rail">
        {steps.map((key, i) => {
          const st = statusOf(key);
          const meta = STEP_META[key];
          return (
            <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              {i > 0 && <span className="pipe-arrow">→</span>}
              <button
                className={`pipe-step ${st}`}
                onClick={() => toggle(key)}
                disabled={live}
                title={live ? undefined : collapsed.has(key) ? "Expand" : "Collapse"}
              >
                <span>{meta.icon}</span>
                <span>{meta.label}</span>
                {!live && <span className="pipe-check">{collapsed.has(key) ? "▸" : "▾"}</span>}
                {live && st === "done" && <span className="pipe-check">✓</span>}
                {live && st === "active" && <span className="pipe-spin" />}
              </button>
            </span>
          );
        })}
      </div>

      {visible.map((s) => (
        <StagePanel
          key={s}
          step={s}
          trace={trace}
          live={live}
          activeStage={activeStage}
          citations={citations}
          answerHtml={answerHtml}
          sparqlFailed={sparqlFailed}
          question={question}
          onPeek={onPeek}
          resolveIri={resolveIri}
        />
      ))}
    </div>
  );
}
