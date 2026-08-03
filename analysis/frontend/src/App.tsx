import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { fetchMeta } from "./api";
import { onGraphFocus } from "./bus";
import { setPrefixes } from "./curie";
import { SETTINGS_EVENT } from "./settings";
import SettingsModal from "./components/SettingsModal";
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
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dark, toggleDark] = useDarkMode();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // L'URL est la source de vérité : navigation avant/arrière du navigateur
  // comprise, et chaque onglet est adressable directement.
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => onGraphFocus(() => navigate("graph")), []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchMeta()
        .then((m) => {
          if (cancelled) return;
          setPrefixes(m.prefixes);
          setMeta(m);
          setError(null);
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    // Recharger quand l'endpoint backend change dans les réglages.
    const onSettings = () => {
      setMeta(null);
      load();
    };
    window.addEventListener(SETTINGS_EVENT, onSettings);
    return () => {
      cancelled = true;
      window.removeEventListener(SETTINGS_EVENT, onSettings);
    };
  }, []);

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
    if (!meta) {
      return <div className="empty-hint">Loading the ontology…</div>;
    }
    // Un seul onglet monté à la fois : quitter Graph libère la scène WebGL
    // et la simulation ; l'état persistant (messages du chat, requête SPARQL,
    // graphe téléchargé) est conservé au niveau module dans chaque onglet.
    return (
      <div className="tab-panel">
        <Suspense
          fallback={<div className="empty-hint">Loading this page…</div>}
        >
          {tab === "graph" && <GraphTab meta={meta} dark={dark} />}
          {tab === "chat" && <ChatTab />}
          {tab === "workspace" && <WorkspaceTab />}
        </Suspense>
      </div>
    );
  }, [error, meta, tab, dark]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          Digital Reference Explorer
          {meta && <span className="version">v{meta.ontology.version}</span>}
        </div>
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
        <button
          className="icon-btn"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          aria-label="Settings"
        >
          ⚙️
        </button>
      </header>
      <main className="app-body">{body}</main>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
