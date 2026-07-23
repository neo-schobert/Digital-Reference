import { useCallback, useMemo, useRef, useState } from "react";
import { runSparql } from "../api";
import { localName, toCurie } from "../curie";
import { buildColorMap, NEUTRAL_DARK, NEUTRAL_LIGHT } from "../palette";
import type { Meta, RdfTerm, SparqlResult } from "../types";
import NetworkCanvas from "../components/NetworkCanvas";

const SAMPLES: { name: string; query: string }[] = [
  {
    name: "Classes and labels",
    query: `PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>

SELECT ?class ?label WHERE {
  ?class a owl:Class ;
         rdfs:label ?label .
  FILTER(LANG(?label) = "en" || LANG(?label) = "")
}
ORDER BY ?label
LIMIT 200`,
  },
  {
    name: "Classes of a lobe (Supply Chain)",
    query: `PREFIX dr: <http://www.w3id.org/ecsel-dr#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?class ?parent WHERE {
  ?class rdfs:subClassOf+ dr:Supply_Chain_Lobe ;
         rdfs:subClassOf ?parent .
  FILTER(isIRI(?parent))
}`,
  },
  {
    name: "Domain → property → range relations",
    query: `PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>

SELECT ?domain ?property ?range WHERE {
  ?property a owl:ObjectProperty ;
            rdfs:domain ?domain ;
            rdfs:range ?range .
  FILTER(isIRI(?domain) && isIRI(?range))
}
LIMIT 300`,
  },
  {
    name: "Subclass count per lobe",
    query: `PREFIX dr: <http://www.w3id.org/ecsel-dr#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>

SELECT ?lobe (COUNT(DISTINCT ?class) AS ?classes) WHERE {
  ?lobe a owl:Class .
  FILTER(STRENDS(STR(?lobe), "_Lobe"))
  ?class rdfs:subClassOf+ ?lobe .
}
GROUP BY ?lobe
ORDER BY DESC(?classes)`,
  },
  {
    name: "Lobe neighborhood (CONSTRUCT)",
    query: `PREFIX dr: <http://www.w3id.org/ecsel-dr#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s rdfs:subClassOf dr:Supply_Chain_Lobe .
  ?s ?p ?o .
  FILTER(isIRI(?o))
}
LIMIT 400`,
  },
];

const PAGE = 400;

interface Props {
  meta: Meta;
  dark: boolean;
}

function termText(t: RdfTerm): string {
  return t.type === "uri" ? toCurie(t.value) : t.value;
}

function download(filename: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(v: string): string {
  return /[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export default function SparqlTab({ meta, dark }: Props) {
  const [query, setQuery] = useState(SAMPLES[0].query);
  const [result, setResult] = useState<SparqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<"list" | "graph">("list");
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setChecked(new Set());
    setLimit(PAGE);
    try {
      const r = await runSparql(query);
      setResult(r);
      if (r.type === "boolean") setView("list");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, [query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void run();
    }
  };

  /* ---------- Lignes actives (sélection de lignes ou tout) ---------- */
  const rows = useMemo(() => {
    if (!result) return [];
    if (result.type === "bindings") return result.results.bindings;
    if (result.type === "graph")
      return result.triples.map((t) => ({ s: t.s, p: t.p, o: t.o }));
    return [];
  }, [result]);

  const vars = useMemo(() => {
    if (!result) return [];
    if (result.type === "bindings") return result.head.vars;
    if (result.type === "graph") return ["s", "p", "o"];
    return [];
  }, [result]);

  const exportRows = useMemo(
    () => (checked.size > 0 ? rows.filter((_, i) => checked.has(i)) : rows),
    [rows, checked]
  );

  /* ---------- Graphe des résultats ---------- */
  const vizData = useMemo(() => {
    const nodes = new Map<string, { id: string; label: string; group: string; degree: number }>();
    const links: { source: string; target: string; kind: "generic"; label?: string }[] = [];
    const ensure = (t: RdfTerm) => {
      const id = t.type === "literal" ? `lit:${t.value}` : t.value;
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          label: t.type === "uri" ? localName(t.value) : t.value.slice(0, 40),
          group: t.type === "uri" ? (toCurie(t.value).split(":")[0] ?? "?") : "literal",
          degree: 0,
        });
      }
      const n = nodes.get(id)!;
      n.degree++;
      return id;
    };

    const activeRows = exportRows;
    const isSPO =
      vars.length === 3 &&
      activeRows.length > 0 &&
      activeRows.every((r) => (r as Record<string, RdfTerm>)[vars[1]]?.type === "uri");

    for (const row of activeRows.slice(0, 1500)) {
      const rec = row as Record<string, RdfTerm>;
      if (isSPO) {
        const s = rec[vars[0]];
        const p = rec[vars[1]];
        const o = rec[vars[2]];
        if (!s || !p || !o) continue;
        links.push({
          source: ensure(s),
          target: ensure(o),
          kind: "generic",
          label: toCurie(p.value),
        });
      } else {
        // Chaîne : chaque paire de colonnes adjacentes forme une arête
        for (let i = 0; i + 1 < vars.length; i++) {
          const a = rec[vars[i]];
          const b = rec[vars[i + 1]];
          if (!a || !b) continue;
          links.push({
            source: ensure(a),
            target: ensure(b),
            kind: "generic",
            label: `${vars[i]} → ${vars[i + 1]}`,
          });
        }
      }
    }
    return { nodes: [...nodes.values()], links };
  }, [exportRows, vars]);

  const groupIds = useMemo(
    () => [...new Set(vizData.nodes.map((n) => n.group))].sort(),
    [vizData]
  );
  const colorMap = useMemo(() => buildColorMap(groupIds, dark), [groupIds, dark]);
  const neutral = dark ? NEUTRAL_DARK : NEUTRAL_LIGHT;
  const colorOf = useCallback(
    (g: string) => colorMap.get(g) ?? neutral,
    [colorMap, neutral]
  );

  /* ---------- Exports ---------- */
  const exportDelimited = (sep: string, ext: string, mime: string) => {
    const header = vars.join(sep);
    const lines = exportRows.map((row) =>
      vars
        .map((v) => {
          const t = (row as Record<string, RdfTerm>)[v];
          return t ? csvEscape(t.value) : "";
        })
        .join(sep)
    );
    download(`sparql-results.${ext}`, mime, [header, ...lines].join("\n"));
  };

  const exportJson = () => {
    if (!result) return;
    if (result.type === "bindings") {
      const partial = {
        head: { vars },
        results: { bindings: exportRows },
      };
      download("sparql-results.json", "application/json", JSON.stringify(partial, null, 2));
    } else if (result.type === "graph") {
      download(
        "sparql-results.json",
        "application/json",
        JSON.stringify({ triples: exportRows }, null, 2)
      );
    } else {
      download("sparql-results.json", "application/json", JSON.stringify(result, null, 2));
    }
  };

  const exportTurtle = () => {
    if (result?.type === "graph" && result.turtle) {
      download("sparql-results.ttl", "text/turtle", result.turtle);
    }
  };

  const toggleRow = (i: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const allShownChecked =
    rows.length > 0 && rows.slice(0, limit).every((_, i) => checked.has(i));

  return (
    <div className="sparql-layout">
      {/* ---------------- Éditeur ---------------- */}
      <div className="sparql-editor-row">
        <textarea
          ref={editorRef}
          className="sparql-editor"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="sparql-side">
          <button className="run-btn" onClick={() => void run()} disabled={running}>
            {running ? "Running…" : "Run (Ctrl+Enter)"}
          </button>
          <select
            value=""
            onChange={(e) => {
              const s = SAMPLES.find((s) => s.name === e.target.value);
              if (s) setQuery(s.query);
            }}
          >
            <option value="" disabled>
              Sample queries…
            </option>
            {SAMPLES.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="hint">
            SELECT, ASK, CONSTRUCT and DESCRIBE are supported (read-only).
            Common prefixes: dr:, rdfs:, owl:, sosa:…
            <br />
            {meta.counts.classes.toLocaleString("en-US")} classes,{" "}
            {meta.ontology.triples.toLocaleString("en-US")} triples.
          </div>
        </div>
      </div>

      {error && <div className="sparql-error">{error}</div>}

      {/* ---------------- Résultats ---------------- */}
      {result && !error && (
        <div className="results-card">
          <div className="results-toolbar">
            {result.type !== "boolean" && (
              <div className="segmented" style={{ width: 180 }}>
                <button
                  className={view === "list" ? "active" : ""}
                  onClick={() => setView("list")}
                >
                  Liste
                </button>
                <button
                  className={view === "graph" ? "active" : ""}
                  onClick={() => setView("graph")}
                >
                  Graphe
                </button>
              </div>
            )}
            <span className="meta">
              {result.type === "boolean"
                ? "Boolean result"
                : `${rows.length.toLocaleString("en-US")} ${
                    result.type === "graph" ? "triples" : "rows"
                  }`}
              {typeof result.tookMs === "number" ? ` · ${result.tookMs} ms` : ""}
              {checked.size > 0 ? ` · ${checked.size} selected` : ""}
            </span>
            <span className="spacer" />
            {result.type !== "boolean" && (
              <>
                <span className="meta">
                  Export {checked.size > 0 ? "selection" : "all"}:
                </span>
                <button
                  className="export-btn"
                  onClick={() => exportDelimited(",", "csv", "text/csv")}
                >
                  CSV
                </button>
                <button
                  className="export-btn"
                  onClick={() =>
                    exportDelimited("\t", "tsv", "text/tab-separated-values")
                  }
                >
                  TSV
                </button>
                <button className="export-btn" onClick={exportJson}>
                  JSON
                </button>
                {result.type === "graph" && (
                  <button className="export-btn" onClick={exportTurtle}>
                    Turtle
                  </button>
                )}
              </>
            )}
          </div>

          <div className="results-body">
            {result.type === "boolean" ? (
              <div className="boolean-result">
                {result.boolean ? "✓ true" : "✗ false"}
              </div>
            ) : view === "list" ? (
              <>
                <table className="results-table">
                  <thead>
                    <tr>
                      <th style={{ width: 30 }}>
                        <input
                          type="checkbox"
                          checked={allShownChecked}
                          onChange={() => {
                            if (allShownChecked) setChecked(new Set());
                            else
                              setChecked(
                                new Set(rows.slice(0, limit).map((_, i) => i))
                              );
                          }}
                        />
                      </th>
                      {vars.map((v) => (
                        <th key={v}>?{v}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, limit).map((row, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            type="checkbox"
                            checked={checked.has(i)}
                            onChange={() => toggleRow(i)}
                          />
                        </td>
                        {vars.map((v) => {
                          const t = (row as Record<string, RdfTerm>)[v];
                          if (!t) return <td key={v} />;
                          return (
                            <td key={v} title={t.value}>
                              {t.type === "uri" ? (
                                <span className="uri">{termText(t)}</span>
                              ) : (
                                <>
                                  {t.value}
                                  {(t["xml:lang"] || t.datatype) && (
                                    <span className="lit-meta">
                                      {t["xml:lang"]
                                        ? `@${t["xml:lang"]}`
                                        : localName(t.datatype!)}
                                    </span>
                                  )}
                                </>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > limit && (
                  <button className="show-more" onClick={() => setLimit((l) => l + PAGE)}>
                    Show {Math.min(PAGE, rows.length - limit)} more rows (
                    {rows.length - limit} remaining)
                  </button>
                )}
              </>
            ) : (
              <div style={{ position: "absolute", inset: 0 }}>
                <NetworkCanvas
                  nodes={vizData.nodes}
                  links={vizData.links}
                  colorOf={colorOf}
                  dark={dark}
                  selectedId={null}
                  onSelect={() => {}}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
