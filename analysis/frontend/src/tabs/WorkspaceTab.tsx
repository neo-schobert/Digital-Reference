import { useCallback, useEffect, useRef, useState } from "react";
import {
  compareOntology,
  deleteWsOntology,
  importWsOntology,
  listWsOntologies,
  loadWsResults,
  mapOntology,
  mappedTtlUrl,
  type CompareReport,
  type MappingReport,
  type WsOntology,
} from "../api";
import { requestGraphFocus } from "../bus";

/**
 * Workspace : importer des ontologies externes, les comparer au Digital
 * Reference et générer une ontologie « mappée » qui se raccroche au DR
 * (equivalentClass / subClassOf / closeMatch) sans jamais le modifier.
 * Tout est persisté côté backend (SQLite + fichiers).
 */

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function scoreColor(score: number): string {
  return score >= 70 ? "#2fa146" : score >= 40 ? "#eda100" : "#e34948";
}

/** Badge donut : score 0-100 rendu en anneau conique + valeur. */
function ScoreBadge({
  score,
  label,
  title,
}: {
  score: number;
  label: string;
  title: string;
}) {
  const color = scoreColor(score);
  return (
    <div className="ws-scorebadge" title={title}>
      <div
        className="ws-donut"
        style={{
          background: `conic-gradient(${color} ${score * 3.6}deg, var(--surface-3) 0deg)`,
        }}
      >
        <span style={{ color }}>{score}%</span>
      </div>
      <span className="ws-scorebadge-label">{label}</span>
    </div>
  );
}

const REL_LABEL: Record<string, string> = {
  equivalent: "≡ equivalent",
  subclass: "⊑ subclass of",
  related: "≈ close match",
  none: "— unlinked",
};

export default function WorkspaceTab() {
  const [ontologies, setOntologies] = useState<WsOntology[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<CompareReport | null>(null);
  const [mapping, setMapping] = useState<MappingReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "import" | `${id}:compare` | `${id}:map`
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"compare" | "mapping">("compare");
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    listWsOntologies()
      .then(setOntologies)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openOntology = useCallback((o: WsOntology) => {
    setSelected(o.id);
    setCompare(null);
    setMapping(null);
    setError(null);
    loadWsResults(o.id)
      .then((r) => {
        setCompare(r.compare);
        setMapping(r.mapping);
        setView(r.mapping ? "mapping" : "compare");
      })
      .catch(() => {});
  }, []);

  const onImport = useCallback(
    async (file: File) => {
      setBusy("import");
      setError(null);
      try {
        const content = await file.text();
        const id = crypto.randomUUID();
        const onto = await importWsOntology(id, file.name, content);
        refresh();
        openOntology(onto);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [refresh, openOntology]
  );

  const runCompare = useCallback(
    async (id: string) => {
      setBusy(`${id}:compare`);
      setError(null);
      try {
        setCompare(await compareOntology(id));
        setView("compare");
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  const runMap = useCallback(
    async (id: string) => {
      setBusy(`${id}:map`);
      setError(null);
      try {
        setMapping(await mapOntology(id));
        setView("mapping");
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this ontology and its results?")) return;
      try {
        await deleteWsOntology(id);
        if (selected === id) {
          setSelected(null);
          setCompare(null);
          setMapping(null);
        }
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [selected, refresh]
  );

  const current = ontologies.find((o) => o.id === selected) ?? null;

  return (
    <div className="ws-page">
      {/* ---- Liste des ontologies importées ---- */}
      <aside className="ws-side">
        <button
          className="new-chat-btn"
          disabled={busy !== null}
          onClick={() => fileRef.current?.click()}
        >
          {busy === "import" ? "Importing…" : "＋ Import ontology"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".ttl,.n3,.nt,.rdf,.owl,.xml"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImport(f);
          }}
        />
        <div className="conv-list">
          {ontologies.map((o) => (
            <div
              key={o.id}
              className={`conv-item${o.id === selected ? " active" : ""}`}
              onClick={() => openOntology(o)}
              title={o.name}
            >
              <div className="conv-title">{o.name}</div>
              <div className="conv-meta">
                {o.classes} classes · {o.triples.toLocaleString("en-US")} triples
                {o.linkScore !== undefined ? (
                  <>
                    {" · "}
                    <strong style={{ color: scoreColor(o.linkScore) }}>
                      {o.linkScore}% linked
                    </strong>
                  </>
                ) : o.similarityScore !== undefined ? (
                  ` · ~${o.similarityScore}% similar`
                ) : (
                  ""
                )}
              </div>
              <button
                className="conv-del"
                title="Delete this ontology"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(o.id);
                }}
              >
                🗑
              </button>
            </div>
          ))}
          {ontologies.length === 0 && (
            <div className="conv-empty">
              No imported ontologies yet.
              <br />
              Supported: .ttl, .rdf, .owl, .nt
            </div>
          )}
        </div>
      </aside>

      {/* ---- Détails / actions ---- */}
      <div className="ws-main">
        {error && <div className="ws-error">⚠️ {error}</div>}

        {!current ? (
          <div className="chat-empty" style={{ flex: 1 }}>
            <div style={{ fontSize: 40 }}>🗂️</div>
            <div>
              Import an external ontology, <strong>compare</strong> it to the
              Digital Reference, then generate a <strong>mapped version</strong>{" "}
              linked to the DR (the DR itself is never modified).
            </div>
          </div>
        ) : (
          <>
            <div className="ws-head">
              <div>
                <div className="ws-title">{current.name}</div>
                <div className="conv-meta">
                  imported {fmtDate(current.createdAt)} · {current.classes}{" "}
                  classes · {current.properties} properties ·{" "}
                  {current.triples.toLocaleString("en-US")} triples
                </div>
              </div>
              <div className="ws-actions">
                {mapping && (
                  <ScoreBadge
                    score={mapping.linkScore}
                    label="DR-link score"
                    title="Weighted coverage: equivalent ×1.0, subclass ×0.9, close match ×0.6, unlinked ×0 — weighted by LLM confidence"
                  />
                )}
                {!mapping && compare && (
                  <ScoreBadge
                    score={compare.similarityScore}
                    label="similarity"
                    title="Average best-match cosine similarity to the DR (before LLM verification)"
                  />
                )}
                <button
                  className="ws-btn"
                  disabled={busy !== null}
                  onClick={() => void runCompare(current.id)}
                >
                  {busy === `${current.id}:compare` ? (
                    <span className="pipe-spin" />
                  ) : (
                    "⚖️"
                  )}{" "}
                  Compare to DR
                </button>
                <button
                  className="ws-btn primary"
                  disabled={busy !== null}
                  onClick={() => void runMap(current.id)}
                  title="LLM-verified alignment — generates a new ontology linked to the DR"
                >
                  {busy === `${current.id}:map` ? <span className="pipe-spin" /> : "🔗"}{" "}
                  Map to DR
                </button>
                {mapping && (
                  <a className="ws-btn" href={mappedTtlUrl(current.id)} download>
                    ⬇ mapped.ttl
                  </a>
                )}
              </div>
            </div>

            {busy === `${current.id}:map` && (
              <div className="ws-progress">
                Aligning classes to the Digital Reference (embedding candidates +
                LLM verification)… this can take a minute for large ontologies.
              </div>
            )}
            {busy === `${current.id}:compare` && (
              <div className="ws-progress">
                Embedding the imported classes and comparing them to the DR
                vector index…
              </div>
            )}

            {(compare || mapping) && (
              <div className="ws-tabs">
                {compare && (
                  <button
                    className={`ws-tab${view === "compare" ? " active" : ""}`}
                    onClick={() => setView("compare")}
                  >
                    Comparison
                  </button>
                )}
                {mapping && (
                  <button
                    className={`ws-tab${view === "mapping" ? " active" : ""}`}
                    onClick={() => setView("mapping")}
                  >
                    Mapping
                  </button>
                )}
              </div>
            )}

            <div className="ws-scroll">
              {view === "compare" && compare && (
                <CompareView report={compare} />
              )}
              {view === "mapping" && mapping && (
                <MappingView report={mapping} />
              )}
              {!compare && !mapping && busy === null && (
                <div className="conv-empty" style={{ paddingTop: 40 }}>
                  Run <strong>Compare to DR</strong> for a quick similarity
                  overview, or <strong>Map to DR</strong> to generate the
                  DR-linked ontology.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------- Vue comparaison ------------------------- */

function CompareView({ report }: { report: CompareReport }) {
  const total = Math.max(1, report.analyzed);
  const pct = (n: number) => Math.round((n / total) * 100);
  return (
    <div>
      <div className="pipe-note" style={{ marginBottom: 8 }}>
        <strong style={{ color: scoreColor(report.similarityScore) }}>
          Average similarity: {report.similarityScore}%
        </strong>{" "}
        — {report.analyzed} classes compared to the DR
        {report.truncated > 0 && ` (${report.truncated} skipped — cap ${total})`} ·
        best-match similarity distribution:
      </div>
      <div className="ws-buckets">
        <div className="ws-bucket">
          <span className="ws-bucket-bar strong" style={{ width: `${pct(report.buckets.strong)}%` }} />
          <span className="ws-bucket-label">
            strong (≥ 0.75) — {report.buckets.strong} ({pct(report.buckets.strong)}%)
          </span>
        </div>
        <div className="ws-bucket">
          <span className="ws-bucket-bar medium" style={{ width: `${pct(report.buckets.medium)}%` }} />
          <span className="ws-bucket-label">
            medium (0.60–0.75) — {report.buckets.medium} ({pct(report.buckets.medium)}%)
          </span>
        </div>
        <div className="ws-bucket">
          <span className="ws-bucket-bar weak" style={{ width: `${pct(report.buckets.weak)}%` }} />
          <span className="ws-bucket-label">
            weak (&lt; 0.60) — {report.buckets.weak} ({pct(report.buckets.weak)}%)
          </span>
        </div>
      </div>
      <table className="ws-table">
        <thead>
          <tr>
            <th>Imported class</th>
            <th>Best DR match</th>
            <th>Module</th>
            <th style={{ textAlign: "right" }}>Similarity</th>
          </tr>
        </thead>
        <tbody>
          {report.matches.map((m) => (
            <tr key={m.sourceIri}>
              <td title={m.sourceIri}>{m.source}</td>
              <td>
                <span
                  className="ws-link"
                  title={`${m.targetIri} — show in the graph`}
                  onClick={() => requestGraphFocus({ iri: m.targetIri })}
                >
                  {m.target}
                </span>
              </td>
              <td className="ws-muted">{m.module}</td>
              <td style={{ textAlign: "right" }}>
                <span
                  className={
                    m.score >= 0.75
                      ? "ws-score strong"
                      : m.score >= 0.6
                        ? "ws-score medium"
                        : "ws-score weak"
                  }
                >
                  {m.score.toFixed(3)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------- Vue mapping --------------------------- */

function MappingView({ report }: { report: MappingReport }) {
  const linked =
    report.counts.equivalent + report.counts.subclass + report.counts.related;
  return (
    <div>
      <div className="pipe-note" style={{ marginBottom: 8 }}>
        <strong style={{ color: scoreColor(report.linkScore) }}>
          DR-link score: {report.linkScore}%
        </strong>{" "}
        — {linked}/{report.entries.length} classes linked to the DR — ≡{" "}
        {report.counts.equivalent} equivalent · ⊑ {report.counts.subclass}{" "}
        subclass · ≈ {report.counts.related} close match · —{" "}
        {report.counts.none} kept unlinked. The generated ontology keeps every
        imported entity and adds the DR link axioms; the DR is untouched.
      </div>
      <table className="ws-table">
        <thead>
          <tr>
            <th>Imported class</th>
            <th>Relation</th>
            <th>DR class</th>
            <th style={{ textAlign: "right" }}>Confidence</th>
          </tr>
        </thead>
        <tbody>
          {report.entries.map((e) => (
            <tr key={e.sourceIri} className={e.relation === "none" ? "ws-none" : ""}>
              <td title={e.sourceIri}>{e.source}</td>
              <td>
                <span className={`ws-rel ${e.relation}`}>{REL_LABEL[e.relation]}</span>
              </td>
              <td>
                {e.targetIri ? (
                  <span
                    className="ws-link"
                    title={`${e.targetIri} — show in the graph`}
                    onClick={() => requestGraphFocus({ iri: e.targetIri! })}
                  >
                    {e.target}
                  </span>
                ) : (
                  <span className="ws-muted">—</span>
                )}
              </td>
              <td style={{ textAlign: "right" }} className="ws-muted">
                {e.confidence !== undefined ? e.confidence.toFixed(2) : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
