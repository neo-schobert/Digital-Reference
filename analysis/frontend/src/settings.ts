/* ------------------------------------------------------------------ */
/* Réglages de l'application (persistés dans localStorage).            */
/*                                                                      */
/* Pour l'instant : l'URL du backend (endpoint). Vide = même origine   */
/* (proxy Vite en dev). Renseignée = appels directs vers ce backend    */
/* (ex. le backend Python http://localhost:3178, CORS activé).         */
/* D'autres réglages viendront s'ajouter ici.                          */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = "dr-explorer-settings";

export interface AppSettings {
  /** Base URL du backend, ex. "http://localhost:3178". Vide = même origine. */
  apiBase: string;
}

const DEFAULTS: AppSettings = { apiBase: "" };

export const SETTINGS_EVENT = "app-settings-changed";

export function getSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    /* localStorage indisponible ou JSON corrompu : valeurs par défaut */
  }
  return { ...DEFAULTS };
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: next }));
  return next;
}

/** Préfixe un chemin /api avec la base backend configurée. */
export function apiUrl(path: string): string {
  const base = getSettings().apiBase.trim().replace(/\/+$/, "");
  return base ? base + path : path;
}
