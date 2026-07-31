/* ------------------------------------------------------------------ */
/* Similarité multi-facettes pour l'alignement d'ontologies.           */
/*                                                                      */
/* Trois facettes indépendantes — lexicale (Levenshtein, Jaro-Winkler,  */
/* Jaccard), structurelle (voisinage, hiérarchie, BM25 de graphe) et    */
/* sémantique (embeddings contextuels, synonymes/altLabels) — chacune   */
/* agrégée à partir de ses sous-métriques puis combinée en un score     */
/* global pondéré. C'est le pattern des matchers OAEI (ASMOV, LSSOM,    */
/* AgreementMakerLight) : les erreurs des trois familles de signaux     */
/* sont décorrélées, leur combinaison bat chaque signal isolé.          */
/*                                                                      */
/* Module pur : aucune dépendance, aucun accès I/O — testable seul.     */
/* ------------------------------------------------------------------ */

/** "IntegratedCircuit_v2" -> "integrated circuit v2" (forme canonique). */
export function normLabel(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ]+/g, " ")
    .trim();
}

/** Tokens (≥ 2 caractères) d'un libellé ou d'un texte court. */
export function labelTokens(s: string): string[] {
  return normLabel(s)
    .split(" ")
    .filter((t) => t.length >= 2);
}

/* ------------------------ Métriques lexicales ----------------------- */

/** Similarité de Levenshtein normalisée : 1 − distance / longueur max. */
export function levenshteinSim(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const cur = [i];
    for (let j = 1; j <= lb; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return 1 - prev[lb] / Math.max(la, lb);
}

function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array<boolean>(la).fill(false);
  const mb = new Array<boolean>(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(lb - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!mb[j] && a[i] === b[j]) {
        ma[i] = true;
        mb[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;
  return (
    (matches / la + matches / lb + (matches - transpositions) / matches) / 3
  );
}

/** Jaro-Winkler : Jaro + bonus de préfixe commun (≤ 4 caractères). */
export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  return j + prefix * 0.1 * (1 - j);
}

/** Jaccard sur ensembles de tokens. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/* --------------------------- BM25 de graphe ------------------------- */

/** Index BM25 : chaque nœud du graphe devient un « document » (label +
    définition + voisinage verbalisé). Le score est normalisé dans [0,1]
    par sa borne supérieure (tous les termes de la requête saturés), ce
    qui le rend comparable entre requêtes.                               */
export class Bm25Index {
  private readonly N: number;
  private avgdl = 0;
  private readonly df = new Map<string, number>();
  private readonly tfs: Map<string, number>[] = [];
  private readonly lens: number[] = [];

  constructor(
    docs: string[][],
    private readonly k1 = 1.2,
    private readonly b = 0.75
  ) {
    this.N = docs.length;
    let total = 0;
    for (const doc of docs) {
      const tf = new Map<string, number>();
      for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.tfs.push(tf);
      this.lens.push(doc.length);
      total += doc.length;
    }
    if (this.N > 0) this.avgdl = total / this.N;
  }

  private idf(t: string): number {
    const df = this.df.get(t) ?? 0;
    return df === 0 ? 0 : Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
  }

  score(query: string[], docIdx: number): number {
    const tf = this.tfs[docIdx];
    if (!tf || this.avgdl === 0) return 0;
    let s = 0;
    let upper = 0;
    for (const t of new Set(query)) {
      const idf = this.idf(t);
      if (idf === 0) continue; // terme inconnu du corpus : hors borne
      upper += idf * (this.k1 + 1);
      const f = tf.get(t) ?? 0;
      if (f === 0) continue;
      const dl = this.lens[docIdx];
      s +=
        (idf * (f * (this.k1 + 1))) /
        (f + this.k1 * (1 - this.b + (this.b * dl) / this.avgdl));
    }
    return upper > 0 ? s / upper : 0;
  }
}

/* ------------------------- Profils d'entités ------------------------ */

/** Vue précalculée d'une classe pour la comparaison : formes normalisées
    du nom, tokens du texte, contexte structurel (parents, voisins).     */
export interface EntityProfile {
  label: string;
  /** label principal normalisé */
  norm: string;
  /** toutes les formes normalisées : label, localName, altLabels */
  variants: string[];
  /** variantes hors label principal (skos:altLabel…) — métrique synonymes */
  altNorms: string[];
  /** tokens du label + définition + altLabels */
  tokens: Set<string>;
  /** labels normalisés des superclasses directes */
  superNorms: string[];
  /** labels normalisés de tous les voisins directs */
  neighborNorms: string[];
}

export function makeProfile(p: {
  label: string;
  localName?: string;
  altLabels?: string[];
  comment?: string;
  superLabels?: string[];
  neighborLabels?: string[];
}): EntityProfile {
  const norm = normLabel(p.label);
  const altNorms = [
    ...new Set(
      (p.altLabels ?? []).map(normLabel).filter((v) => v && v !== norm)
    ),
  ];
  const localNorm = p.localName ? normLabel(p.localName) : "";
  const variants = [
    ...new Set([norm, localNorm, ...altNorms].filter(Boolean)),
  ];
  const tokens = new Set([
    ...labelTokens(p.label),
    ...labelTokens(p.comment ?? ""),
    ...altNorms.flatMap((a) => a.split(" ").filter((t) => t.length >= 2)),
  ]);
  return {
    label: p.label,
    norm,
    variants,
    altNorms,
    tokens,
    superNorms: [
      ...new Set((p.superLabels ?? []).map(normLabel).filter(Boolean)),
    ],
    neighborNorms: [
      ...new Set((p.neighborLabels ?? []).map(normLabel).filter(Boolean)),
    ],
  };
}

/* ------------------------ Agrégation pondérée ----------------------- */

/** Moyenne pondérée en ignorant les composantes indisponibles (les poids
    restants sont renormalisés) ; undefined si tout est indisponible.    */
function wavg(parts: [number | undefined, number][]): number | undefined {
  let sum = 0;
  let weight = 0;
  for (const [v, w] of parts) {
    if (v === undefined) continue;
    sum += v * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : undefined;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Meilleur score d'une métrique de chaîne sur le produit des variantes. */
function bestPair(
  as: string[],
  bs: string[],
  fn: (a: string, b: string) => number
): number {
  let best = 0;
  for (const a of as)
    for (const b of bs) {
      const s = fn(a, b);
      if (s > best) best = s;
    }
  return best;
}

/* Appariement « soft » d'ensembles de labels : chaque élément de A est
   apparié à son meilleur homologue dans B, mais un score Jaro-Winkler
   sous 0.55 (le bruit de fond entre mots quelconques est ~0.4-0.5) ne
   compte pour rien — sans ce seuil, deux voisinages sans AUCUN rapport
   obtiendraient ~0.45 et la métrique ne discriminerait plus.           */
function squash(s: number): number {
  return s <= 0.55 ? 0 : Math.min(1, (s - 0.55) / 0.45);
}

function directedSetSim(as: string[], bs: string[]): number {
  if (as.length === 0 || bs.length === 0) return 0;
  let sum = 0;
  for (const a of as) sum += squash(bestPair([a], bs, jaroWinkler));
  return sum / as.length;
}

/** Similarité symétrique de deux ensembles de labels normalisés. */
function softSetSim(as: string[], bs: string[]): number {
  return (directedSetSim(as, bs) + directedSetSim(bs, as)) / 2;
}

export interface FacetDetail {
  levenshtein: number;
  jaro: number;
  jaccard: number;
  neighborhood?: number;
  hierarchy?: number;
  bm25?: number;
  contextual?: number;
  synonym?: number;
}

export interface FacetScores {
  lexical: number;
  structural?: number;
  semantic?: number;
  aggregated: number;
  detail: FacetDetail;
}

/* Poids : la facette sémantique domine (le signal le plus fiable seul),
   mais lexical + structurel pèsent ensemble davantage — un désaccord
   entre facettes se voit dans le score ET reste inspectable via detail. */
const W_LEXICAL = 0.3;
const W_STRUCTURAL = 0.25;
const W_SEMANTIC = 0.45;

export function compareEntities(
  a: EntityProfile,
  b: EntityProfile,
  opts: { contextual?: number; bm25?: number } = {}
): FacetScores {
  /* Lexical : métriques d'édition sur la meilleure paire de variantes,
     Jaccard sur les tokens label+définition. */
  const levenshtein = bestPair(a.variants, b.variants, levenshteinSim);
  const jaroSc = bestPair(a.variants, b.variants, jaroWinkler);
  const jaccardSc = jaccard(a.tokens, b.tokens);
  const lexical = 0.35 * levenshtein + 0.4 * jaroSc + 0.25 * jaccardSc;

  /* Structurel : appariement soft des voisinages et des parents (le
     Jaccard strict sur tokens échoue dès que les deux ontologies n'ont
     pas le même vocabulaire), BM25 du contexte de graphe (calculé en
     amont sur l'index DR). */
  const neighborhood =
    a.neighborNorms.length > 0 && b.neighborNorms.length > 0
      ? softSetSim(a.neighborNorms, b.neighborNorms)
      : undefined;
  const hierarchy =
    a.superNorms.length > 0 && b.superNorms.length > 0
      ? softSetSim(a.superNorms, b.superNorms)
      : undefined;
  const structural = wavg([
    [neighborhood, 0.4],
    [hierarchy, 0.3],
    [opts.bm25 !== undefined ? clamp01(opts.bm25) : undefined, 0.3],
  ]);
  /* Fiabilité du signal structurel : avec 1-2 voisins déclarés, c'est du
     bruit — son poids dans l'agrégation croît avec la richesse du
     contexte disponible (côté le plus pauvre des deux).                */
  const structSize = (p: EntityProfile) =>
    p.neighborNorms.length + p.superNorms.length;
  const structRichness = Math.min(
    1,
    Math.min(structSize(a), structSize(b)) / 4
  );

  /* Sémantique : cosinus d'embeddings + appariement par labels alternatifs
     (un altLabel qui colle au nom de l'autre classe = synonymie déclarée). */
  const contextual =
    opts.contextual !== undefined ? clamp01(opts.contextual) : undefined;
  const synonym =
    a.altNorms.length > 0 || b.altNorms.length > 0
      ? Math.max(
          bestPair(a.altNorms, b.variants, jaroWinkler),
          bestPair(a.variants, b.altNorms, jaroWinkler)
        )
      : undefined;
  const semantic = wavg([
    [contextual, 0.75],
    [synonym, 0.25],
  ]);

  let aggregated =
    wavg([
      [lexical, W_LEXICAL],
      [structural, W_STRUCTURAL * structRichness],
      [semantic, W_SEMANTIC],
    ]) ?? 0;
  /* Plancher lexical : labels normalisés identiques => quasi-certitude,
     une variante identique (localName, altLabel) => très probable.      */
  if (a.norm.length > 2 && a.norm === b.norm)
    aggregated = Math.max(aggregated, 0.95);
  else if (
    a.variants.some((v) => v.length > 2 && b.variants.includes(v))
  )
    aggregated = Math.max(aggregated, 0.9);

  return {
    lexical,
    structural,
    semantic,
    aggregated,
    detail: {
      levenshtein,
      jaro: jaroSc,
      jaccard: jaccardSc,
      neighborhood,
      hierarchy,
      bm25: opts.bm25,
      contextual,
      synonym,
    },
  };
}
