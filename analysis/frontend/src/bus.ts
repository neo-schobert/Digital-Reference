/**
 * Mini bus d'événements : le chatbot demande à l'onglet Graph de se focaliser
 * sur un nœud ou une relation. App bascule l'onglet, GraphTab applique la
 * sélection (les onglets restent montés, l'état du graphe est conservé).
 */

export type GraphFocusRequest =
  | { iri: string }
  | { from: string; to: string; via?: string };

type Listener = (r: GraphFocusRequest) => void;

let pending: GraphFocusRequest | null = null;
const listeners = new Set<Listener>();

export function requestGraphFocus(r: GraphFocusRequest): void {
  pending = r;
  listeners.forEach((l) => l(r));
}

/** Récupère (et efface) la demande en attente — pour un onglet qui vient de monter. */
export function consumeGraphFocus(): GraphFocusRequest | null {
  const p = pending;
  pending = null;
  return p;
}

/** Re-stocke une demande sans notifier (graphe pas encore chargé). */
export function stashGraphFocus(r: GraphFocusRequest): void {
  pending = r;
}

export function onGraphFocus(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
