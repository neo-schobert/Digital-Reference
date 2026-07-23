/** Raccourcit une IRI en CURIE à partir de la table de préfixes du backend. */

let table: [string, string][] = [];

export function setPrefixes(prefixes: Record<string, string>) {
  // Trier par namespace décroissant pour matcher le plus spécifique d'abord
  table = Object.entries(prefixes).sort((a, b) => b[1].length - a[1].length);
}

export function toCurie(iri: string): string {
  for (const [prefix, ns] of table) {
    if (iri.startsWith(ns)) return `${prefix}:${iri.slice(ns.length)}`;
  }
  return iri;
}

export function localName(iri: string): string {
  const idx = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/"));
  return idx >= 0 ? iri.slice(idx + 1) : iri;
}
