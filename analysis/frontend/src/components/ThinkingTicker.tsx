import { useEffect, useRef, useState } from "react";

/**
 * Indicateur d'attente du mode simple : un mot qui tourne (façon Claude Code)
 * mais avec le vocabulaire de la maison — procédés semi-conducteur, physique
 * du silicium et concepts de la Digital Reference — plus le temps écoulé.
 *
 * Le chrono et la rotation des mots sont dérivés de `startedAt` (l'instant de
 * l'envoi, détenu par ChatTab) et non d'un état interne : basculer le mode
 * expert démonte ce composant, mais le décompte reste continu.
 */

const WORDS = [
  "Doping",
  "Wafering",
  "Etching",
  "Sintering",
  "Sputtering",
  "Annealing",
  "Lithographing",
  "Dicing",
  "Die-attaching",
  "Wire-bonding",
  "Passivating",
  "Trenching",
  "Photoresisting",
  "Bandgapping",
  "Electron-herding",
  "Hole-chasing",
  "Carrier-drifting",
  "Gate-driving",
  "Commutating",
  "Freewheeling",
  "Derating",
  "Avalanching",
  "Voltage-blocking",
  "Junction-cooling",
  "Thermal-cycling",
  "Kelvin-sensing",
  "Bias-tuning",
  "Yield-hunting",
  "Bin-sorting",
  "Wafer-probing",
  "Reflowing",
  "Clean-rooming",
  "Fab-walking",
  "Tape-and-reeling",
  "ESD-grounding",
  "Nanometre-splitting",
  "Polytyping SiC",
  "Tickling GaN",
  "Silicon-whispering",
  "Ontologising",
  "Triple-storing",
  "Subclass-climbing",
  "Lobe-scanning",
  "Carbon-counting",
  "Footprint-tracing",
  "Supply-chaining",
  "Datasheet-diving",
];

const SLOT_MS = 2200;

/** Un paquet mélangé, consommé sans répétition puis remélangé. */
function deck(): string[] {
  const d = [...WORDS];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export default function ThinkingTicker({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const elapsed = Math.max(0, now - startedAt);
  const slot = Math.floor(elapsed / SLOT_MS);

  // Un mot par créneau de 2,2 s, mémorisé : le mot affiché ne change qu'au
  // passage d'un créneau, jamais à cause d'un simple re-rendu.
  const pile = useRef<string[]>(deck());
  const chosen = useRef<Map<number, string>>(new Map());
  if (!chosen.current.has(slot)) {
    if (pile.current.length === 0) pile.current = deck();
    chosen.current.set(slot, pile.current.pop() as string);
  }
  const word = chosen.current.get(slot) as string;

  return (
    <div className="thinking">
      <span className="thinking-orb" />
      <span key={slot} className="thinking-word">
        {word}…
      </span>
      <span className="thinking-secs">{Math.floor(elapsed / 1000)}s</span>
    </div>
  );
}
