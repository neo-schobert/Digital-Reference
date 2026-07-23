/**
 * Palette catégorielle (8 slots validés pour l'accessibilité, en ordre fixe,
 * cf. méthode dataviz) puis extensions pour les groupes au-delà de 8.
 * L'identité d'un groupe n'est jamais portée par la couleur seule : la légende
 * (puces + noms) et les panneaux de détail nomment toujours le groupe.
 */

const CATEGORICAL_LIGHT = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
];

const CATEGORICAL_DARK = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#008300",
  "#9085e9",
  "#e66767",
];

/* Extensions (au-delà des 8 slots validés) : teintes distinctes choisies à la
   main, plus foncées/claires selon le mode. */
const EXTRA_LIGHT = [
  "#0d7f8c", // teal foncé
  "#8a5a2a", // brun
  "#5a7186", // bleu-gris
  "#7a8a00", // olive
  "#a04ba0", // pourpre
  "#c96a8d", // vieux rose
  "#3f6ec4", // bleu ardoise
  "#996e12", // ocre
];

const EXTRA_DARK = [
  "#2ba7b5",
  "#b07a3f",
  "#7f99b0",
  "#9aad33",
  "#c06ac0",
  "#d98aa8",
  "#6a92dd",
  "#c29433",
];

export const NEUTRAL_LIGHT = "#898781";
export const NEUTRAL_DARK = "#898781";

/**
 * Attribue une couleur à chaque identifiant de groupe, dans l'ordre fourni
 * (ordre fixe : la couleur suit l'entité, pas son rang dans un filtre).
 */
export function buildColorMap(ids: string[], dark: boolean): Map<string, string> {
  const base = dark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT;
  const extra = dark ? EXTRA_DARK : EXTRA_LIGHT;
  const all = [...base, ...extra];
  const map = new Map<string, string>();
  ids.forEach((id, i) => {
    if (i < all.length) {
      map.set(id, all[i]);
    } else {
      // Repli déterministe (angle d'or) pour les groupes très nombreux
      const hue = (i * 137.508) % 360;
      map.set(id, `hsl(${hue.toFixed(0)}, ${dark ? 45 : 55}%, ${dark ? 60 : 40}%)`);
    }
  });
  return map;
}
