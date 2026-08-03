/*
 * Épinglages de nœuds (positions figées à la main dans la visualisation).
 *
 * - Store en mémoire au niveau module : les pins survivent aux changements
 *   d'onglet et aux remontages du canvas, tant que la page reste ouverte.
 * - « Save » copie l'état courant dans localStorage : les pins sont alors
 *   ré-appliqués au prochain chargement de la page.
 * - « Reset » libère tout (mémoire ET sauvegarde).
 *
 * Les positions 2D et 3D sont indépendantes (les layouts diffèrent).
 */

export type PinDim = "2d" | "3d";

const STORAGE_KEY = "dr-pinned-nodes";

type PinMap = Map<string, number[]>;

function loadSaved(): Record<PinDim, PinMap> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      "2d": new Map(Object.entries(raw["2d"] ?? {})),
      "3d": new Map(Object.entries(raw["3d"] ?? {})),
    };
  } catch {
    return { "2d": new Map(), "3d": new Map() };
  }
}

const mem = loadSaved();

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

/** S'abonner aux changements (compteur vivant dans l'UI). */
export function subscribePins(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getPin(dim: PinDim, id: string): number[] | undefined {
  return mem[dim].get(id);
}

export function setPin(dim: PinDim, id: string, pos: number[]): void {
  mem[dim].set(id, pos);
  notify();
}

export function removePin(dim: PinDim, id: string): void {
  if (mem[dim].delete(id)) notify();
}

export function totalPinCount(): number {
  return mem["2d"].size + mem["3d"].size;
}

/**
 * Classes épinglées, tous modes de vue confondus : une classe épinglée à la
 * fois en 2D et en 3D ne compte qu'une fois. Sert à exporter la sélection
 * faite à la main dans le graphe.
 */
export function pinnedIds(): string[] {
  return [...new Set([...mem["2d"].keys(), ...mem["3d"].keys()])];
}

/** Persiste l'état courant : il sera restauré au prochain chargement. */
export function savePins(): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      "2d": Object.fromEntries(mem["2d"]),
      "3d": Object.fromEntries(mem["3d"]),
    })
  );
  notify();
}

/** Libère tous les pins, y compris la sauvegarde. */
export function clearPins(): void {
  mem["2d"].clear();
  mem["3d"].clear();
  localStorage.removeItem(STORAGE_KEY);
  notify();
}
