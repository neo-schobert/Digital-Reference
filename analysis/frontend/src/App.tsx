import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { fetchMeta, listProjects, type Project } from "./api";
import { onGraphFocus } from "./bus";
import { setPrefixes } from "./curie";
import type { Meta } from "./types";

// Chaque onglet est une « page » : sa propre URL (#/graph, #/chat…) et son
// propre bundle JS chargé à la demande — three.js et force-graph ne sont
// téléchargés que si l'on visite Graph.
const GraphTab = lazy(() => import("./tabs/GraphTab"));
const ChatTab = lazy(() => import("./tabs/ChatTab"));
const WorkspaceTab = lazy(() => import("./tabs/WorkspaceTab"));

type Tab = "graph" | "chat" | "workspace";

const TAB_IDS: Tab[] = ["graph", "chat", "workspace"];

function tabFromHash(): Tab {
  const h = window.location.hash.replace(/^#\/?/, "");
  return (TAB_IDS as string[]).includes(h) ? (h as Tab) : "graph";
}

function navigate(tab: Tab): void {
  window.location.hash = `/${tab}`;
}

const TABS: { id: Tab; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "chat", label: "ChatBot" },
  { id: "workspace", label: "Workspace" },
];

const PROJECT_KEY = "dr.project";

const shortName = (file: string) => file.replace(/\.[^.]+$/, "");

/**
 * Sélecteur de projet : le projet courant avec sa référence, et la liste
 * déroulante des autres. Un `<select>` natif ne montrait que le nom, alors
 * que ce qui compte pour choisir, c'est la référence du projet.
 */
function ProjectPicker({
  projects,
  currentId,
  onSelect,
  onManage,
}: {
  projects: Project[] | null;
  currentId: string | null;
  onSelect: (id: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = projects?.find((p) => p.id === currentId) ?? null;
  const empty = !projects || projects.length === 0;

  return (
    <div className="project-picker" ref={boxRef}>
      <button
        className={`pp-button${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Current project — one project, one reference ontology"
      >
        <span className="pp-badge">◈</span>
        <span className="pp-text">
          <span className="pp-name">{current?.name ?? "No project"}</span>
          <span className={`pp-ref${current?.referenceName ? "" : " none"}`}>
            {current?.referenceName
              ? `★ ${shortName(current.referenceName)}`
              : empty
                ? "create one in the Workspace"
                : "no reference ontology"}
          </span>
        </span>
        <span className="pp-chevron">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="pp-menu" role="listbox">
          <div className="pp-menu-head">Projects</div>
          {empty && <div className="pp-empty">No project yet.</div>}
          {projects?.map((p) => (
            <button
              key={p.id}
              className={`pp-item${p.id === currentId ? " active" : ""}`}
              role="option"
              aria-selected={p.id === currentId}
              onClick={() => {
                onSelect(p.id);
                setOpen(false);
              }}
            >
              <span className="pp-item-name">
                {p.name}
                {p.id === currentId && <span className="pp-check">✓</span>}
              </span>
              <span className="pp-item-meta">
                {p.referenceName ? (
                  <span className="pp-item-ref">★ {shortName(p.referenceName)}</span>
                ) : (
                  <span className="ws-noref">no reference</span>
                )}
                {` · ${p.ontologyCount} ontolog${p.ontologyCount === 1 ? "y" : "ies"}`}
                {p.chatCount > 0 && ` · ${p.chatCount} chats`}
              </span>
            </button>
          ))}
          <button
            className="pp-manage"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            ＋ New project / manage…
          </button>
        </div>
      )}
    </div>
  );
}

function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  return [dark, () => setDark((d) => !d)];
}

export default function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(
    () => localStorage.getItem(PROJECT_KEY)
  );
  const [meta, setMeta] = useState<Meta | null>(null);
  /** Message expliquant pourquoi la référence n'est pas disponible (409…) */
  const [metaError, setMetaError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dark, toggleDark] = useDarkMode();

  // L'URL est la source de vérité : navigation avant/arrière du navigateur
  // comprise, et chaque onglet est adressable directement.
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => onGraphFocus(() => navigate("graph")), []);

  const refreshProjects = useCallback(async (): Promise<Project[]> => {
    const list = await listProjects();
    setProjects(list);
    setCurrentId((id) => {
      const kept = id && list.some((p) => p.id === id) ? id : (list[0]?.id ?? null);
      return kept;
    });
    return list;
  }, []);

  useEffect(() => {
    refreshProjects().catch((e) =>
      setError(e instanceof Error ? e.message : String(e))
    );
  }, [refreshProjects]);

  useEffect(() => {
    if (currentId) localStorage.setItem(PROJECT_KEY, currentId);
  }, [currentId]);

  const current = useMemo(
    () => projects?.find((p) => p.id === currentId) ?? null,
    [projects, currentId]
  );

  /* La référence du projet : rechargée à chaque changement de projet. Un
     projet sans référence renvoie 409 — Graph et ChatBot sont alors bloqués
     mais le Workspace reste utilisable pour en désigner une. */
  const reloadMeta = useCallback(() => {
    if (!currentId) {
      setMeta(null);
      setMetaError(null);
      return;
    }
    setMeta(null);
    setMetaError(null);
    fetchMeta(currentId)
      .then((m) => {
        setPrefixes(m.prefixes);
        setMeta(m);
      })
      .catch((e) => setMetaError(e instanceof Error ? e.message : String(e)));
  }, [currentId]);

  useEffect(reloadMeta, [reloadMeta]);

  /* Le Workspace prévient quand un projet, sa référence ou ses dépendances
     changent : la liste et la référence sont rechargées. */
  const onProjectsChanged = useCallback(
    (nextId?: string) => {
      refreshProjects()
        .then(() => {
          if (nextId) setCurrentId(nextId);
          else reloadMeta();
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    },
    [refreshProjects, reloadMeta]
  );

  const needsReference = (what: string) => (
    <div className="gate">
      <div className="gate-icon">🎯</div>
      <h2>No reference ontology</h2>
      <p>
        {what} needs the reference ontology of the project{" "}
        <strong>{current?.name}</strong>.
      </p>
      <p className="gate-hint">{metaError}</p>
      <button className="ws-btn primary" onClick={() => navigate("workspace")}>
        Open the Workspace to pick a reference
      </button>
    </div>
  );

  const body = useMemo(() => {
    if (error) {
      return (
        <div className="empty-hint">
          Cannot reach the backend ({error}).
          <br />
          Make sure it is running: <code>analysis/start.sh</code>
        </div>
      );
    }
    if (!projects) return <div className="empty-hint">Loading projects…</div>;

    // Un seul onglet monté à la fois : quitter Graph libère la scène WebGL
    // et la simulation. Les onglets sont montés avec la clé du projet :
    // changer de projet réinitialise proprement leur état interne.
    return (
      <div className="tab-panel">
        <Suspense fallback={<div className="empty-hint">Loading this page…</div>}>
          {tab === "workspace" && (
            <WorkspaceTab
              projects={projects}
              currentId={currentId}
              onSelectProject={setCurrentId}
              onProjectsChanged={onProjectsChanged}
            />
          )}
          {tab === "graph" &&
            (!current ? (
              <div className="gate">
                <div className="gate-icon">🗂️</div>
                <h2>No project yet</h2>
                <p>Create a project in the Workspace, then import its ontologies.</p>
                <button className="ws-btn primary" onClick={() => navigate("workspace")}>
                  Open the Workspace
                </button>
              </div>
            ) : meta ? (
              <GraphTab key={current.id} project={current} meta={meta} dark={dark} />
            ) : metaError ? (
              needsReference("The graph")
            ) : (
              <div className="empty-hint">Loading the ontology…</div>
            ))}
          {tab === "chat" &&
            (!current ? (
              <div className="gate">
                <div className="gate-icon">🗂️</div>
                <h2>No project yet</h2>
                <p>Create a project in the Workspace to start chatting with it.</p>
                <button className="ws-btn primary" onClick={() => navigate("workspace")}>
                  Open the Workspace
                </button>
              </div>
            ) : meta ? (
              <ChatTab key={current.id} project={current} meta={meta} />
            ) : metaError ? (
              needsReference("The chatbot")
            ) : (
              <div className="empty-hint">Loading the ontology…</div>
            ))}
        </Suspense>
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, projects, currentId, current, meta, metaError, tab, dark, onProjectsChanged]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          Ontology Explorer
          {meta?.ontology.version && (
            <span className="version">v{meta.ontology.version}</span>
          )}
        </div>
        <ProjectPicker
          projects={projects}
          currentId={currentId}
          onSelect={setCurrentId}
          onManage={() => navigate("workspace")}
        />
        <nav className="tab-bar">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab-btn ${tab === t.id ? "active" : ""}`}
              onClick={() => navigate(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button
          className="icon-btn"
          onClick={toggleDark}
          title={dark ? "Switch to light theme" : "Switch to dark theme"}
        >
          {dark ? "☀️" : "🌙"}
        </button>
      </header>
      <main className="app-body">{body}</main>
    </div>
  );
}
