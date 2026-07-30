import { useEffect, useMemo, useState } from "react";
import { fetchMeta } from "./api";
import { onGraphFocus } from "./bus";
import { setPrefixes } from "./curie";
import type { Meta } from "./types";
import GraphTab from "./tabs/GraphTab";
import SparqlTab from "./tabs/SparqlTab";
import ChatTab from "./tabs/ChatTab";

type Tab = "graph" | "sparql" | "chat";

const TABS: { id: Tab; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "sparql", label: "SPARQL" },
  { id: "chat", label: "ChatBot" },
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
  const [tab, setTab] = useState<Tab>("graph");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dark, toggleDark] = useDarkMode();

  useEffect(() => onGraphFocus(() => setTab("graph")), []);

  useEffect(() => {
    fetchMeta()
      .then((m) => {
        setPrefixes(m.prefixes);
        setMeta(m);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
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
        {tab === "graph" && <GraphTab meta={meta} dark={dark} />}
        {tab === "sparql" && <SparqlTab meta={meta} dark={dark} />}
        {tab === "chat" && <ChatTab />}
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
              onClick={() => setTab(t.id)}
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
