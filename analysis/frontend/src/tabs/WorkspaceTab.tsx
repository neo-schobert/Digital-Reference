import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  compareOntology,
  createProject,
  deleteOntology,
  deleteProject,
  importOntology,
  listOntologies,
  loadResults,
  mapOntology,
  mappedTtlUrl,
  ontologyFileUrl,
  patchOntology,
  sssomTsvUrl,
  updateProject,
  type CompareReport,
  type FacetSummary,
  type MappingReport,
  type Project,
  type ProjectOntology,
} from "../api";
import { requestGraphFocus } from "../bus";
import SidePanel from "../components/SidePanel";

/**
 * Workspace : gestion des PROJETS.
 *
 * Un projet = une ontologie de référence + les ontologies importées qu'on
 * lui compare. On crée un projet, on y importe des ontologies, on en
 * désigne une comme référence (et on lui donne ses dépendances, comme le
 * Digital Reference a SOSA / SSN / Time). Comparaison et mapping se font
 * ensuite contre la référence du projet — jamais modifiée — et le graphe
 * comme le chatbot travaillent sur ce même projet.
 */

interface Props {
  projects: Project[];
  currentId: string | null;
  onSelectProject: (id: string) => void;
  /** Prévient l'application (liste des projets + référence à recharger) */
  onProjectsChanged: (nextId?: string) => void;
}

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
  equivalent: "≡ exact match",
  subclass: "⊑ broad match",
  related: "≈ close match",
  none: "— unlinked",
};

/* Mini-barres lexical / structurel / sémantique : montrent POURQUOI un
   match est proposé (un lexical fort + structurel faible = faux ami
   probable ; l'inverse = vrai match sous un autre nom). */
const FACETS: [keyof FacetSummary, string, string][] = [
  ["lexical", "lex", "#4a90d9"],
  ["structural", "str", "#9b59b6"],
  ["semantic", "sem", "#2fa146"],
];

function FacetBars({ facets }: { facets?: FacetSummary }) {
  if (!facets) return <span className="ws-muted">—</span>;
  const title = FACETS.map(([key, name]) => {
    const v = facets[key];
    return `${name === "lex" ? "lexical" : name === "str" ? "structural" : "semantic"}: ${
      v !== undefined ? v.toFixed(3) : "n/a"
    }`;
  }).join("\n");
  return (
    <div className="ws-facets" title={title}>
      {FACETS.map(([key, name, color]) => {
        const v = facets[key];
        return (
          <div className="ws-facet" key={key}>
            <span className="ws-facet-name">{name}</span>
            <span className="ws-facet-bar">
              {v !== undefined && (
                <span
                  className="ws-facet-fill"
                  style={{ width: `${Math.round(v * 100)}%`, background: color }}
                />
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function WorkspaceTab({
  projects,
  currentId,
  onSelectProject,
  onProjectsChanged,
}: Props) {
  const [ontologies, setOntologies] = useState<ProjectOntology[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<CompareReport | null>(null);
  const [mapping, setMapping] = useState<MappingReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"compare" | "mapping">("compare");
  const [depsOpen, setDepsOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const project = useMemo(
    () => projects.find((p) => p.id === currentId) ?? null,
    [projects, currentId]
  );

  const refresh = useCallback(() => {
    if (!currentId) {
      setOntologies([]);
      return Promise.resolve([] as ProjectOntology[]);
    }
    return listOntologies(currentId)
      .then((list) => {
        setOntologies(list);
        return list;
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        return [] as ProjectOntology[];
      });
  }, [currentId]);

  useEffect(() => {
    setSelected(null);
    setCompare(null);
    setMapping(null);
    setError(null);
    setDepsOpen(false);
    void refresh();
  }, [refresh]);

  const openOntology = useCallback(
    (o: ProjectOntology) => {
      setSelected(o.id);
      setCompare(null);
      setMapping(null);
      setError(null);
      setDepsOpen(false);
      if (!currentId) return;
      loadResults(currentId, o.id)
        .then((r) => {
          setCompare(r.compare);
          setMapping(r.mapping);
          setView(r.mapping ? "mapping" : "compare");
        })
        .catch(() => {});
    },
    [currentId]
  );

  /* --------------------------- Projets --------------------------- */

  const newProject = useCallback(async () => {
    const name = window.prompt("Project name (one project = one reference ontology):");
    if (name === null) return;
    if (!name.trim()) return;
    setBusy("project");
    setError(null);
    try {
      const p = await createProject(name.trim());
      onProjectsChanged(p.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [onProjectsChanged]);

  const renameProject = useCallback(async () => {
    if (!project) return;
    const name = window.prompt("Rename the project:", project.name);
    if (name === null || !name.trim() || name === project.name) return;
    try {
      await updateProject(project.id, { name: name.trim() });
      onProjectsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [project, onProjectsChanged]);

  const removeProject = useCallback(
    async (p: Project) => {
      if (
        !window.confirm(
          `Delete the project "${p.name}"?\nIts ${p.ontologyCount} ontologies, mappings and ${p.chatCount} conversations are deleted too.`
        )
      )
        return;
      try {
        await deleteProject(p.id);
        onProjectsChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [onProjectsChanged]
  );

  /* -------------------------- Ontologies -------------------------- */

  const onImport = useCallback(
    async (files: FileList) => {
      if (!currentId) return;
      setBusy("import");
      setError(null);
      try {
        let last: ProjectOntology | null = null;
        for (const file of Array.from(files)) {
          last = await importOntology(currentId, file.name, await file.text());
        }
        const list = await refresh();
        onProjectsChanged();
        const fresh = last && list.find((o) => o.id === last!.id);
        if (fresh) openOntology(fresh);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [currentId, refresh, openOntology, onProjectsChanged]
  );

  const setReference = useCallback(
    async (ontologyId: string | null) => {
      if (!project) return;
      setBusy("reference");
      setError(null);
      try {
        await updateProject(project.id, { referenceId: ontologyId });
        await refresh();
        onProjectsChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [project, refresh, onProjectsChanged]
  );

  const toggleDep = useCallback(
    async (ontologyId: string, depId: string, on: boolean) => {
      if (!currentId) return;
      const onto = ontologies.find((o) => o.id === ontologyId);
      if (!onto) return;
      const deps = on
        ? [...onto.deps, depId]
        : onto.deps.filter((d) => d !== depId);
      setError(null);
      try {
        await patchOntology(currentId, ontologyId, { deps });
        await refresh();
        onProjectsChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [currentId, ontologies, refresh, onProjectsChanged]
  );

  const runCompare = useCallback(
    async (id: string) => {
      if (!currentId) return;
      setBusy(`${id}:compare`);
      setError(null);
      try {
        setCompare(await compareOntology(currentId, id));
        setView("compare");
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [currentId, refresh]
  );

  const runMap = useCallback(
    async (id: string) => {
      if (!currentId) return;
      setBusy(`${id}:map`);
      setError(null);
      try {
        setMapping(await mapOntology(currentId, id));
        setView("mapping");
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [currentId, refresh]
  );

  const remove = useCallback(
    async (id: string) => {
      if (!currentId) return;
      if (!window.confirm("Delete this ontology and its results?")) return;
      try {
        await deleteOntology(currentId, id);
        if (selected === id) {
          setSelected(null);
          setCompare(null);
          setMapping(null);
        }
        await refresh();
        onProjectsChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [currentId, selected, refresh, onProjectsChanged]
  );

  const current = ontologies.find((o) => o.id === selected) ?? null;
  const reference = ontologies.find((o) => o.isReference) ?? null;
  const nameById = useMemo(
    () => new Map(ontologies.map((o) => [o.id, o.name])),
    [ontologies]
  );

  return (
    <div className="ws-page">
      {/* ---- Projets ---- */}
      <SidePanel
        id="ws-projects"
        side="left"
        title="Projects"
        defaultWidth={250}
        min={190}
        max={460}
        className="ws-side"
      >
        <button className="new-chat-btn" disabled={busy !== null} onClick={() => void newProject()}>
          ＋ New project
        </button>
        <div className="conv-list">
          {projects.map((p) => (
            <div
              key={p.id}
              className={`conv-item${p.id === currentId ? " active" : ""}`}
              onClick={() => onSelectProject(p.id)}
              title={p.description || p.name}
            >
              <div className="conv-title">{p.name}</div>
              <div className="conv-meta">
                {p.ontologyCount} ontolog{p.ontologyCount === 1 ? "y" : "ies"}
                {p.referenceName ? (
                  <>
                    {" · "}
                    <span className="ws-ref-chip" title={`Reference: ${p.referenceName}`}>
                      ★ {p.referenceName.replace(/\.[^.]+$/, "")}
                    </span>
                  </>
                ) : (
                  <span className="ws-noref"> · no reference</span>
                )}
              </div>
              <button
                className="conv-del"
                title="Delete this project"
                onClick={(e) => {
                  e.stopPropagation();
                  void removeProject(p);
                }}
              >
                🗑
              </button>
            </div>
          ))}
          {projects.length === 0 && (
            <div className="conv-empty">
              No project yet.
              <br />
              Create one, then import its ontologies.
            </div>
          )}
        </div>
      </SidePanel>

      {/* ---- Contenu du projet ---- */}
      <div className="ws-main">
        {error && <div className="ws-error">⚠️ {error}</div>}

        {!project ? (
          <div className="chat-empty" style={{ flex: 1 }}>
            <div style={{ fontSize: 40 }}>🗂️</div>
            <div>
              A <strong>project</strong> holds one <strong>reference ontology</strong>{" "}
              and the ontologies you map onto it. Create a project to get started.
            </div>
          </div>
        ) : (
          <>
            <div className="ws-project-head">
              <div>
                <div className="ws-title">
                  {project.name}
                  <button
                    className="ws-icon-btn"
                    title="Rename this project"
                    onClick={() => void renameProject()}
                  >
                    ✎
                  </button>
                </div>
                <div className="conv-meta">
                  {reference ? (
                    <>
                      reference: <strong>{reference.name}</strong>
                      {reference.deps.length > 0 &&
                        ` + ${reference.deps.length} dependenc${reference.deps.length === 1 ? "y" : "ies"}`}
                      {project.referenceLocked && (
                        <span
                          className="ws-locked"
                          title="Comparisons or mappings already point to this reference: changing it (or its dependencies) would invalidate them. Delete the aligned ontologies to unfreeze it."
                        >
                          {" · 🔒 frozen"}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="ws-noref">
                      no reference yet — pick one below to unlock the graph, the
                      chatbot and the mapping
                    </span>
                  )}
                </div>
              </div>
              <div className="ws-actions">
                <button
                  className="ws-btn primary"
                  disabled={busy !== null}
                  onClick={() => fileRef.current?.click()}
                >
                  {busy === "import" ? <span className="pipe-spin" /> : "＋"} Import
                  ontology
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept=".ttl,.n3,.nt,.rdf,.owl,.xml"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    if (e.target.files?.length) void onImport(e.target.files);
                  }}
                />
              </div>
            </div>

            {/* ---- Ontologies du projet ---- */}
            <div className="ws-onto-strip">
              {ontologies.map((o) => (
                <button
                  key={o.id}
                  className={`ws-onto-card${o.id === selected ? " active" : ""}${
                    o.inReference ? " reference" : ""
                  }`}
                  onClick={() => openOntology(o)}
                  title={
                    o.isReference
                      ? `${o.name} — reference ontology of the project`
                      : o.inReference
                        ? `${o.name} — dependency of the reference: loaded with it, so it is already part of it`
                        : `${o.name} — ${o.classes} classes, ${o.triples.toLocaleString("en-US")} triples`
                  }
                >
                  <span className="ws-onto-name">
                    {o.isReference && <span className="ws-star">★</span>}
                    {!o.isReference && o.inReference && (
                      <span className="ws-dep-mark">⛓</span>
                    )}
                    {o.name}
                  </span>
                  <span className="ws-onto-meta">
                    {o.classes} classes
                    {!o.isReference && o.inReference && " · in reference"}
                    {o.linkScore !== undefined && (
                      <>
                        {" · "}
                        <strong style={{ color: scoreColor(o.linkScore) }}>
                          {o.linkScore}% linked
                        </strong>
                      </>
                    )}
                  </span>
                </button>
              ))}
              {ontologies.length === 0 && (
                <div className="conv-empty" style={{ padding: "10px 4px" }}>
                  No ontology in this project yet — import .ttl, .rdf, .owl or .nt
                  files, then mark one as the reference.
                </div>
              )}
            </div>

            {!current ? (
              <div className="chat-empty" style={{ flex: 1 }}>
                <div style={{ fontSize: 40 }}>📚</div>
                <div>
                  Select an ontology above to set it as the project{" "}
                  <strong>reference</strong>, choose its <strong>dependencies</strong>,
                  or map it onto the reference.
                </div>
              </div>
            ) : (
              <>
                <div className="ws-head">
                  <div>
                    <div className="ws-title">{current.name}</div>
                    <div className="conv-meta">
                      imported {fmtDate(current.createdAt)} · {current.classes} classes ·{" "}
                      {current.properties} properties ·{" "}
                      {current.triples.toLocaleString("en-US")} triples
                      {!current.isReference && current.inReference && (
                        <>
                          {" · "}
                          <span className="ws-dep-note">
                            ⛓ dependency of the reference
                          </span>
                        </>
                      )}
                      {current.ontologyIri && (
                        <>
                          {" · "}
                          <span className="ws-muted" title={current.ontologyIri}>
                            {current.ontologyIri}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="ws-actions">
                    {mapping && (
                      <ScoreBadge
                        score={mapping.linkScore}
                        label="link score"
                        title="Weighted coverage: equivalent ×1.0, subclass ×0.9, close match ×0.6, unlinked ×0 — weighted by LLM confidence"
                      />
                    )}
                    {!mapping && compare && (
                      <ScoreBadge
                        score={compare.similarityScore}
                        label="similarity"
                        title="Average best-match aggregated similarity to the reference (lexical + structural + semantic facets, before LLM verification)"
                      />
                    )}
                    {current.isReference ? (
                      <button
                        className="ws-btn"
                        disabled={busy !== null || project.referenceLocked}
                        title={
                          project.referenceLocked
                            ? "Reference frozen: comparisons or mappings already point to it"
                            : "Detach this ontology from the reference role"
                        }
                        onClick={() => void setReference(null)}
                      >
                        {project.referenceLocked ? "🔒" : "★"} Reference
                        {!project.referenceLocked && " — unset"}
                      </button>
                    ) : (
                      <button
                        className="ws-btn"
                        disabled={busy !== null || project.referenceLocked}
                        title={
                          project.referenceLocked
                            ? "Reference frozen: comparisons or mappings already point to the current reference"
                            : "Make this ontology the reference of the project (graph, chatbot and mappings target it)"
                        }
                        onClick={() => void setReference(current.id)}
                      >
                        ☆ Set as reference
                      </button>
                    )}
                    <button
                      className="ws-btn"
                      onClick={() => setDepsOpen((v) => !v)}
                      title="Ontologies this one imports (loaded with it, like SOSA/SSN for the Digital Reference)"
                    >
                      🔗 Dependencies ({current.deps.length})
                    </button>
                    {!current.inReference && (
                      <>
                        <button
                          className="ws-btn"
                          disabled={busy !== null || !project.referenceId}
                          title={
                            project.referenceId
                              ? "Similarity overview against the project reference"
                              : "Set a reference ontology first"
                          }
                          onClick={() => void runCompare(current.id)}
                        >
                          {busy === `${current.id}:compare` ? (
                            <span className="pipe-spin" />
                          ) : (
                            "⚖️"
                          )}{" "}
                          Compare
                        </button>
                        <button
                          className="ws-btn primary"
                          disabled={busy !== null || !project.referenceId}
                          title={
                            project.referenceId
                              ? "LLM-verified alignment — generates a new ontology linked to the reference"
                              : "Set a reference ontology first"
                          }
                          onClick={() => void runMap(current.id)}
                        >
                          {busy === `${current.id}:map` ? <span className="pipe-spin" /> : "🔗"}{" "}
                          Map to reference
                        </button>
                      </>
                    )}
                    <a className="ws-btn" href={ontologyFileUrl(project.id, current.id)} download>
                      ⬇ source
                    </a>
                    {mapping && (
                      <a className="ws-btn" href={mappedTtlUrl(project.id, current.id)} download>
                        ⬇ mapped.ttl
                      </a>
                    )}
                    {mapping?.sssomFile && (
                      <a
                        className="ws-btn"
                        href={sssomTsvUrl(project.id, current.id)}
                        download
                        title="SSSOM TSV — standard exchange format for ontology mappings"
                      >
                        ⬇ SSSOM
                      </a>
                    )}
                    <button
                      className="ws-btn"
                      disabled={current.inReference && project.referenceLocked}
                      title={
                        current.inReference && project.referenceLocked
                          ? "Reference frozen: it cannot be removed while comparisons or mappings point to it"
                          : "Delete this ontology"
                      }
                      onClick={() => void remove(current.id)}
                    >
                      🗑
                    </button>
                  </div>
                </div>

                {depsOpen && (
                  <div className="ws-deps">
                    <div className="ws-deps-title">
                      Dependencies of <strong>{current.name}</strong> — imported
                      ontologies loaded together with it
                      {current.isReference &&
                        " (they are part of the project reference graph)"}
                    </div>
                    {current.inReference && project.referenceLocked && (
                      <div className="ws-locked">
                        🔒 Frozen — the reference is what every comparison and
                        mapping was computed against.
                      </div>
                    )}
                    {ontologies.filter((o) => o.id !== current.id).length === 0 ? (
                      <div className="ws-muted">
                        Import other ontologies in this project to use them as
                        dependencies.
                      </div>
                    ) : (
                      <div className="ws-deps-list">
                        {ontologies
                          .filter((o) => o.id !== current.id)
                          .map((o) => (
                            <label key={o.id} className="check-row">
                              <input
                                type="checkbox"
                                checked={current.deps.includes(o.id)}
                                disabled={current.inReference && project.referenceLocked}
                                onChange={(e) =>
                                  void toggleDep(current.id, o.id, e.target.checked)
                                }
                              />
                              {o.name}
                              <span className="ws-muted"> · {o.classes} classes</span>
                            </label>
                          ))}
                      </div>
                    )}
                  </div>
                )}

                {current.deps.length > 0 && !depsOpen && (
                  <div className="ws-deps-chips">
                    {current.deps.map((d) => (
                      <span className="ws-chip" key={d}>
                        {nameById.get(d) ?? d}
                      </span>
                    ))}
                  </div>
                )}

                {busy === `${current.id}:map` && (
                  <div className="ws-progress">
                    Aligning classes to {reference?.name ?? "the reference"} (embedding
                    candidates + LLM verification)… this can take a minute for large
                    ontologies.
                  </div>
                )}
                {busy === `${current.id}:compare` && (
                  <div className="ws-progress">
                    Embedding the imported classes and comparing them to the reference
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
                  {view === "compare" && compare && <CompareView report={compare} />}
                  {view === "mapping" && mapping && <MappingView report={mapping} />}
                  {!compare && !mapping && busy === null && (
                    <div className="conv-empty" style={{ paddingTop: 30 }}>
                      {current.isReference ? (
                        <>
                          This ontology is the <strong>reference</strong> of the project:
                          the graph, the SPARQL endpoint and the chatbot are built from
                          it. Import another ontology to map it here.
                        </>
                      ) : current.inReference ? (
                        <>
                          This ontology is a <strong>dependency of the reference</strong>
                          {reference ? ` (${reference.name})` : ""}: it is loaded with it,
                          so it is already part of the reference — comparing or mapping it
                          would mean comparing it to itself. Uncheck it from the
                          reference dependencies to align it separately.
                        </>
                      ) : project.referenceId ? (
                        <>
                          Run <strong>Compare</strong> for a quick similarity overview,
                          or <strong>Map to reference</strong> to generate the linked
                          ontology.
                        </>
                      ) : (
                        <>
                          This project has <strong>no reference</strong> yet — set one
                          above (★) to enable comparison, mapping, the graph and the
                          chatbot.
                        </>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
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
        — {report.analyzed} classes compared to the reference
        {report.truncated > 0 && ` (${report.truncated} skipped — cap ${total})`} ·
        aggregated multi-facet score (lexical + structural + semantic) · best-match
        distribution:
      </div>
      <div className="ws-buckets">
        <div className="ws-bucket">
          <span className="ws-bucket-bar strong" style={{ width: `${pct(report.buckets.strong)}%` }} />
          <span className="ws-bucket-label">
            strong (≥ 0.70) — {report.buckets.strong} ({pct(report.buckets.strong)}%)
          </span>
        </div>
        <div className="ws-bucket">
          <span className="ws-bucket-bar medium" style={{ width: `${pct(report.buckets.medium)}%` }} />
          <span className="ws-bucket-label">
            medium (0.55–0.70) — {report.buckets.medium} ({pct(report.buckets.medium)}%)
          </span>
        </div>
        <div className="ws-bucket">
          <span className="ws-bucket-bar weak" style={{ width: `${pct(report.buckets.weak)}%` }} />
          <span className="ws-bucket-label">
            weak (&lt; 0.55) — {report.buckets.weak} ({pct(report.buckets.weak)}%)
          </span>
        </div>
      </div>
      <table className="ws-table">
        <thead>
          <tr>
            <th>Imported class</th>
            <th>Best reference match</th>
            <th>Module</th>
            <th>Facets</th>
            <th style={{ textAlign: "right" }}>Score</th>
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
              <td>
                <FacetBars facets={m.facets} />
              </td>
              <td style={{ textAlign: "right" }}>
                <span
                  className={
                    m.score >= 0.7
                      ? "ws-score strong"
                      : m.score >= 0.55
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
          Link score: {report.linkScore}%
        </strong>{" "}
        — {linked}/{report.entries.length} classes linked to the reference — ≡{" "}
        {report.counts.equivalent} exact · ⊑ {report.counts.subclass} broad · ≈{" "}
        {report.counts.related} close · — {report.counts.none} kept unlinked. SKOS
        mapping axioms, reified with their similarity facets (SSSOM); the reference is
        untouched.
      </div>
      <table className="ws-table">
        <thead>
          <tr>
            <th>Imported class</th>
            <th>Relation</th>
            <th>Reference class</th>
            <th>Facets</th>
            <th style={{ textAlign: "right" }}>Confidence</th>
          </tr>
        </thead>
        <tbody>
          {report.entries.map((e) => (
            <tr key={e.sourceIri} className={e.relation === "none" ? "ws-none" : ""}>
              <td title={e.sourceIri}>
                {e.source}
                {e.importance !== undefined && e.importance >= 0.5 && (
                  <span
                    className="ws-important"
                    title={`Central class in the imported ontology (importance ${e.importance.toFixed(2)})`}
                  >
                    ★
                  </span>
                )}
              </td>
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
              <td>
                {e.relation !== "none" ? (
                  <FacetBars facets={e.facets} />
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
