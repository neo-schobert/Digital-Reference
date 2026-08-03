import { useEffect, useState } from "react";
import { apiHeaders, apiUrl, getSettings, saveSettings } from "../settings";

/* ------------------------------------------------------------------ */
/* Modal de réglages (roue crantée). Pour l'instant : l'endpoint du    */
/* backend. D'autres réglages viendront s'ajouter ici plus tard.       */
/* ------------------------------------------------------------------ */

interface Props {
  onClose: () => void;
}

type TestState = { status: "idle" | "testing" | "ok" | "error"; detail?: string };

export default function SettingsModal({ onClose }: Props) {
  const [apiBase, setApiBase] = useState(getSettings().apiBase);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  // Fermeture au clavier (Échap).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = () => {
    saveSettings({ apiBase: apiBase.trim() });
    onClose();
  };

  const testConnection = async () => {
    setTest({ status: "testing" });
    // Teste la valeur en cours d'édition, sans l'enregistrer.
    const base = apiBase.trim().replace(/\/+$/, "");
    const url = base ? `${base}/api/health` : "/api/health";
    try {
      const res = await fetch(url, { headers: apiHeaders(url) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = await res.json();
      setTest({
        status: "ok",
        detail: `OK — ${body.triples ?? "?"} triples${body.configured === false ? " (LLM offline)" : ""}`,
      });
    } catch (e) {
      setTest({ status: "error", detail: e instanceof Error ? e.message : String(e) });
    }
  };

  const effective = apiUrl("/api");

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="settings-body">
          <label className="settings-field">
            <span className="settings-label">Backend endpoint</span>
            <input
              type="text"
              className="settings-input"
              placeholder="http://localhost:3178  (empty = same origin)"
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
              spellCheck={false}
              autoFocus
            />
            <span className="settings-hint">
              Base URL of the backend. Leave empty to use the dev proxy (same origin).
              Requests will target <code>{effective}…</code>
            </span>
          </label>

          <div className="settings-test">
            <button className="settings-btn" onClick={testConnection} disabled={test.status === "testing"}>
              {test.status === "testing" ? "Testing…" : "Test connection"}
            </button>
            {test.status === "ok" && <span className="settings-ok">✓ {test.detail}</span>}
            {test.status === "error" && <span className="settings-err">✕ {test.detail}</span>}
          </div>
        </div>

        <div className="settings-actions">
          <button className="settings-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="settings-btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
