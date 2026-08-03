/**
 * Moteur d'enregistrement de la démo.
 *
 *   1. synthétise la narration (edge-tts) et mesure la durée de chaque phrase ;
 *   2. rejoue le scénario dans un Chromium piloté par Playwright, qui enregistre
 *      la vidéo, en notant l'instant réel de départ de chaque beat ;
 *   3. remonte l'audio aux instants mesurés et mixe le tout en MP4.
 *
 * Aucun compte, aucun service payant : edge-tts tape l'endpoint public de
 * lecture à voix haute d'Edge, Playwright encode la vidéo lui-même.
 *
 * Usage : ./record.sh [--lang fr|en] [--fast] [--silent] [--out fichier.mp4]
 */

import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beats, meta as scenarioMeta, VOICES } from "./scenario.mjs";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ANALYSIS = resolve(HERE, "..");
const OUT = join(HERE, "out");
const WORK = join(OUT, "work");
const SAMPLE = join(ANALYSIS, "exemple", "factory-logistics.ttl");
const DATA_DIR = join(ANALYSIS, ".data");

const BACKEND = process.env.DR_BACKEND ?? "http://localhost:3178";
const FRONTEND = process.env.DR_FRONTEND ?? "http://localhost:5173";
const FFMPEG = process.env.FFMPEG ?? join(process.env.HOME, ".local/bin/ffmpeg");
const PY = process.env.PYTHON ?? "python3";

const W = 1920;
const H = 1080;
/** Respiration entre la fin d'une phrase et le beat suivant. */
const GAP_MS = 450;

/* ------------------------------ arguments ------------------------------ */

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const LANG = arg("lang", "en");
const FAST = flag("fast");
const SILENT = flag("silent");
const OUTFILE = resolve(arg("out", join(OUT, `dr-demo-${LANG}.mp4`)));

if (!["fr", "en"].includes(LANG)) {
  console.error(`--lang doit valoir fr ou en (reçu : ${LANG})`);
  process.exit(1);
}

const log = (...m) => console.log("·", ...m);

/* ------------------------------- outillage ------------------------------ */

async function probeDurationMs(file) {
  // ffmpeg suffit : pas besoin de ffprobe séparé.
  const { stderr } = await exec(FFMPEG, ["-hide_banner", "-i", file], {
    maxBuffer: 1 << 22,
  }).catch((e) => e); // ffmpeg sort en erreur quand il n'y a pas de sortie
  const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr ?? "");
  if (!m) throw new Error(`durée illisible pour ${file}`);
  return Math.round(
    (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
  );
}

async function synthesize() {
  if (SILENT) return beats.map(() => ({ file: null, ms: 3200 }));
  mkdirSync(WORK, { recursive: true });
  const voice = VOICES[LANG];
  const tracks = [];
  for (const [i, b] of beats.entries()) {
    const file = join(WORK, `${String(i).padStart(2, "0")}-${b.id}.mp3`);
    await exec(PY, [
      "-m", "edge_tts",
      "--voice", voice,
      "--text", b[LANG],
      "--write-media", file,
    ]);
    const ms = await probeDurationMs(file);
    tracks.push({ file, ms });
    log(`voix ${i + 1}/${beats.length} — ${b.id} (${(ms / 1000).toFixed(1)} s)`);
  }
  return tracks;
}

/* --------------------------- état du workspace -------------------------- */

const api = async (path, init) => {
  const r = await fetch(BACKEND + path, init);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : null;
};

/**
 * La démo importe puis aligne l'ontologie d'exemple en direct : il ne doit
 * pas déjà y en avoir une du même nom, sinon la liste en montre deux. On
 * sauvegarde `.data` avant de supprimer quoi que ce soit.
 */
async function prepareWorkspace() {
  const list = await api("/api/workspace/ontologies");
  const dupes = list.filter((o) => /factory-logistics/i.test(o.name));
  if (FAST) {
    const mapped = dupes.find((o) => o.hasMapping);
    if (!mapped)
      throw new Error(
        "--fast exige une ontologie factory-logistics déjà mappée dans le Workspace"
      );
    log(`mode --fast : réutilisation de « ${mapped.name} » (${mapped.id})`);
    return;
  }
  if (dupes.length === 0) return;

  const backup = join(OUT, "backup-data");
  if (existsSync(DATA_DIR)) {
    rmSync(backup, { recursive: true, force: true });
    cpSync(DATA_DIR, backup, { recursive: true });
    log(`sauvegarde de .data → ${backup}`);
  }
  for (const o of dupes) {
    await api(`/api/workspace/ontologies/${o.id}`, { method: "DELETE" });
    log(`supprimé du Workspace : ${o.name} (${o.id}) — restaurable depuis la sauvegarde`);
  }
}

/* -------------------------------- helpers ------------------------------- */

function makeHelpers(page, ctx) {
  const canvas = () => page.locator("canvas").first();

  /**
   * Affiche la phrase en cours et met à jour le marqueur de synchronisation.
   *
   * Playwright n'horodate pas fidèlement sa vidéo : il empile les images reçues
   * à cadence fixe, si bien qu'un instant mesuré côté Node dérive de plusieurs
   * secondes sur quatre minutes. Le carré `#__sync`, dont la couleur alterne à
   * chaque phrase, est relu dans la vidéo encodée : c'est lui qui donne la
   * vraie position de chaque beat (voir detectBeatTimes).
   */
  const caption = async (text, marker) => {
    await page.evaluate(
      ({ t, m }) => {
        let el = document.getElementById("__cap");
        if (!el) {
          el = document.createElement("div");
          el.id = "__cap";
          el.style.cssText = `position:fixed;left:0;right:0;bottom:0;z-index:2147483646;
            padding:30px 110px 34px;text-align:center;pointer-events:none;
            font:500 32px/1.45 -apple-system,Segoe UI,system-ui,sans-serif;color:#fff;
            text-shadow:0 2px 10px rgba(0,0,0,.85);
            background:linear-gradient(transparent,rgba(0,0,0,.80) 55%);
            transition:opacity .3s;opacity:0`;
          document.body.appendChild(el);
        }
        el.textContent = t;
        el.style.opacity = t ? "1" : "0";

        if (m) {
          let s = document.getElementById("__sync");
          if (!s) {
            s = document.createElement("div");
            s.id = "__sync";
            s.style.cssText = `position:fixed;left:0;bottom:0;width:12px;height:12px;
              z-index:2147483647;pointer-events:none`;
            document.body.appendChild(s);
          }
          s.style.background = m;
        }
      },
      { t: text, m: marker }
    );
  };

  const toast = async (text, ms = 2600) => {
    await page.evaluate(
      ({ t, ms }) => {
        const el = document.createElement("div");
        el.textContent = t;
        el.style.cssText = `position:fixed;top:76px;left:50%;transform:translateX(-50%);
          z-index:2147483645;
          padding:12px 18px;border-radius:10px;background:#1c7c3a;color:#fff;
          font:600 17px/1.3 -apple-system,Segoe UI,system-ui,sans-serif;
          box-shadow:0 8px 26px rgba(0,0,0,.35);transition:opacity .35s;opacity:0`;
        document.body.appendChild(el);
        requestAnimationFrame(() => (el.style.opacity = "1"));
        setTimeout(() => {
          el.style.opacity = "0";
          setTimeout(() => el.remove(), 400);
        }, ms);
      },
      { t: text, ms }
    );
  };

  const pause = (ms) => page.waitForTimeout(ms);

  /** Carte plein écran de fin (appel à retours). */
  const endCard = async (title, lines) => {
    await page.evaluate(
      ({ t, l }) => {
        let el = document.getElementById("__end");
        if (!el) {
          el = document.createElement("div");
          el.id = "__end";
          // sous le sous-titre et sous le marqueur de synchro, qui doivent rester lisibles
          el.style.cssText = `position:fixed;inset:0;z-index:2147483644;display:flex;
            flex-direction:column;align-items:center;justify-content:center;gap:34px;
            text-align:center;padding:0 12%;background:rgba(252,252,253,.96);
            font-family:-apple-system,Segoe UI,system-ui,sans-serif;
            transition:opacity .7s;opacity:0`;
          document.body.appendChild(el);
        }
        el.innerHTML =
          `<div style="font-size:76px;font-weight:700;line-height:1.1;color:#111">${t}</div>` +
          l
            .map(
              (x) =>
                `<div style="font-size:34px;line-height:1.45;color:#3c4043;max-width:1200px">${x}</div>`
            )
            .join("");
        requestAnimationFrame(() => (el.style.opacity = "1"));
      },
      { t: title, l: lines }
    );
  };

  /**
   * Fait tourner la caméra autour de l'élément sélectionné, `turns` tours en
   * `ms` millisecondes (1 = tour complet). Le graphe est en `controlType:
   * "orbit"`, donc un glissement horizontal égal à la HAUTEUR du canvas vaut
   * exactement 360° d'azimut (THREE.OrbitControls rapporte les deux axes à
   * clientHeight). Comme le canvas est plus large que haut, un tour tient dans
   * un seul glissement ; au-delà on enchaîne des segments, invisible à l'image
   * puisque le curseur n'est pas enregistré.
   *
   * La boucle est bornée par l'horloge et non par un nombre de pas : chaque
   * aller-retour vers le navigateur coûte bien plus que le délai demandé.
   *
   * Rotation au CLIC-MOLETTE et non au clic droit : les deux tournent la
   * caméra (`MIDDLE`/`RIGHT` → `THREE.MOUSE.ROTATE`), mais le clic droit est
   * aussi capté par le glisser de nœud de force-graph. Comme la classe
   * sélectionnée est pile au centre, chaque rotation l'attrapait et finissait
   * par l'épingler — d'où des épingles surgissant sans raison.
   */
  const orbit = async (ms, turns = 0.35) => {
    const box = await canvas().boundingBox();
    if (!box) return pause(ms);
    const y = box.y + box.height / 2;
    const total = box.height * turns; // pixels de glissement horizontal
    const span = Math.min(box.width - 90, box.height);
    const segments = Math.max(1, Math.ceil(total / span));
    const perSeg = total / segments;
    const msPerSeg = ms / segments;
    const x0 = box.x + (box.width - perSeg) / 2;

    for (let s = 0; s < segments; s++) {
      await page.mouse.move(x0, y);
      await page.mouse.down({ button: "middle" });
      const t0 = Date.now();
      let frac = 0;
      while (frac < 1) {
        frac = Math.min(1, (Date.now() - t0) / msPerSeg);
        // léger balancement vertical, qui revient à zéro : moins mécanique
        await page.mouse.move(x0 + perSeg * frac, y + Math.sin(frac * Math.PI) * 12);
      }
      await page.mouse.up({ button: "middle" });
    }
    // Une rotation qui démarre pile sur un nœud l'attrape et l'épingle : on
    // efface ces épingles parasites tant que la séquence d'épinglage n'a pas
    // eu lieu, pour que le compteur n'apparaisse que quand on le raconte.
    if (!ctx.pinDemoDone) await clearStrayPins();
  };

  const clearStrayPins = async () => {
    const reset = page.locator(".pin-box button", { hasText: "Reset" });
    if (await reset.count()) await reset.first().click().catch(() => {});
  };

  const scroll = async (selector, px, ms) => {
    const el = page.locator(selector).first();
    const end = Date.now() + ms;
    const started = Date.now();
    let done = 0;
    while (Date.now() < end) {
      const target = (px * (Date.now() - started)) / ms;
      const step = target - done;
      done = target;
      await el.evaluate((n, d) => n.scrollBy({ top: d }), step);
      await pause(45);
    }
  };

  const tab = async (label) => {
    await page.getByRole("button", { name: label, exact: true }).first().click();
    await pause(600);
  };

  /**
   * Cherche une classe et sélectionne le résultat dont le libellé correspond
   * exactement — la liste est triée par degré, donc « Semiconductor Product »
   * arrive derrière « Semiconductor Production Lobe ».
   */
  const searchClass = async (name) => {
    const box = page.locator(".search-box input");
    await box.fill("");
    await box.pressSequentially(name, { delay: 70 });
    const results = page.locator(".search-results button");
    await results.first().waitFor({ timeout: 10000 });
    await pause(500);
    const labels = (await results.allInnerTexts()).map((t) => t.split("\n")[0].trim());
    const i = labels.indexOf(name);
    if (i < 0) console.warn(`!! « ${name} » absent des résultats : ${labels.join(", ")}`);
    await results.nth(Math.max(0, i)).click();
    await pause(600);
  };

  const importOntology = async () => {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: /Import ontology/ }).click(),
    ]);
    await chooser.setFiles(SAMPLE);
    await page.locator(".ws-head").waitFor({ timeout: 30000 });
  };

  /**
   * Déclenche une action longue du Workspace et attend sa vraie fin. On guette
   * d'abord l'apparition du spinner : `waitFor` peut déjà être à l'écran au
   * moment du clic (la barre d'onglets existe dès la comparaison), et une
   * attente naïve rendrait la main aussitôt.
   */
  const wsAction = async (label, waitFor, timeout = 60000) => {
    const spin = page.locator(".pipe-spin").first();
    await page.locator(".ws-btn", { hasText: label }).click();
    await spin.waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
    await spin.waitFor({ state: "detached", timeout }).catch(() => {});
    await page.locator(waitFor).first().waitFor({ timeout: 30000 });
  };

  const wsTab = async (name) => {
    await page.locator(".ws-tab", { hasText: name }).click();
    await pause(400);
  };

  /**
   * Panneau « Ontologies » : bascule off / raw / linked pour l'import.
   * `focus` met l'ontologie en évidence et estompe le Digital Reference —
   * indispensable, treize classes sur mille deux cents sont invisibles sinon.
   */
  const overlay = async (mode, { focus = false } = {}) => {
    const toggle = page.locator(".layers-toggle").first();
    if ((await toggle.textContent())?.trim().startsWith("▸")) await toggle.click();
    const row = page
      .locator(".layers-row")
      .filter({ hasText: "factory-logistics" })
      .first();
    await row.waitFor({ timeout: 20000 });
    await row.getByRole("button", { name: mode, exact: true }).click();
    await pause(900);
    if (focus) {
      await row.locator(".layers-name").click();
      await pause(900);
    }
  };

  /** Annule la mise en évidence d'un calque (le reste cesse d'être estompé). */
  const unfocus = async () => {
    const focused = page.locator(".layers-name.focused");
    if (await focused.count()) {
      await focused.first().click();
      await pause(600);
    }
  };

  /**
   * Épingle le nœud sélectionné : il est au centre de la vue après un
   * `selectAndFocus`. Le pin s'arme au bout de 850 ms de drag immobile.
   */
  /** Molette sur le graphe : delta positif = recul de la caméra. */
  const zoom = async (delta, ms = 1200) => {
    const box = await canvas().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, delta / steps);
      await pause(ms / steps);
    }
  };

  /**
   * Épingle le nœud sélectionné (il est au centre après un `selectAndFocus`)
   * en l'écartant franchement de ses voisins : le déplacement rend l'épinglage
   * lisible à l'image, là où un micro-glissement passait inaperçu.
   */
  /**
   * Annule la sélection en cliquant sur une zone vide du graphe. Une sélection
   * active estompe tout le reste : sans ça, le seuil d'importance se joue sur
   * un graphe déjà gris et ne se lit pas.
   *
   * À appeler APRÈS avoir reculé la caméra : le graphe se resserre alors au
   * centre et les coins deviennent réellement vides. Un clic qui tombe sur un
   * nœud le sélectionne au lieu de désélectionner, d'où les essais successifs.
   */
  const deselect = async () => {
    const box = await canvas().boundingBox();
    const spots = [
      [0.02, 0.96], [0.98, 0.96], [0.02, 0.06], [0.98, 0.06],
      [0.5, 0.02], [0.02, 0.5], [0.98, 0.5], [0.5, 0.98],
    ];
    for (const [fx, fy] of spots) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      await pause(700);
      const status = await page.locator(".graph-status").innerText();
      if (!status.includes("selected:") && !status.includes("edge:")) {
        log(`  désélection ok — ${status.split("\n")[0].trim()}`);
        return true;
      }
    }
    console.warn("!! sélection impossible à annuler : le seuil sera moins lisible");
    return false;
  };

  const pinNode = async ({ dx = -420, dy = -250, offsets } = {}) => {
    // Une orbite peut avoir accroché un nœud au passage : on repart de zéro
    // pour que le compteur qui apparaît soit bien celui de la démonstration.
    const reset = page.locator(".pin-box button", { hasText: "Reset" });
    if (await reset.count()) {
      await reset.first().click();
      await pause(600);
    }
    const box = await canvas().boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // Vu de très loin les nœuds ne font que quelques pixels : on resserre les
    // essais autour du centre, où se trouve la classe qu'on vient de choisir.
    for (const [ox, oy] of offsets ?? [[0, 0], [0, -14], [14, 0], [-14, 10]]) {
      await page.mouse.move(cx + ox, cy + oy);
      await page.mouse.down();
      const steps = 26;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(cx + ox + (dx * i) / steps, cy + oy + (dy * i) / steps);
        await pause(45);
      }
      await pause(1600); // maintien immobile : l'anneau d'épinglage apparaît
      await page.mouse.up();
      await pause(600);
      if (await page.locator(".pin-box").isVisible().catch(() => false)) {
        ctx.pinDemoDone = true; // les orbites suivantes ne l'effaceront pas
        await toast("📌 node pinned", 2600);
        return true;
      }
    }
    console.warn("!! épinglage manqué : on se rapproche et on réessaie");
    await zoom(-900, 1200);
    for (const [ox, oy] of [[0, 0], [0, -10], [10, 0]]) {
      await page.mouse.move(cx + ox, cy + oy);
      await page.mouse.down();
      for (let i = 1; i <= 20; i++) {
        await page.mouse.move(cx + ox + (dx * 0.7 * i) / 20, cy + oy + (dy * 0.7 * i) / 20);
        await pause(45);
      }
      await pause(1600);
      await page.mouse.up();
      await pause(600);
      if (await page.locator(".pin-box").isVisible().catch(() => false)) {
        ctx.pinDemoDone = true;
        await toast("📌 node pinned", 2600);
        return true;
      }
    }
    console.warn("!! épinglage définitivement manqué");
    return false;
  };

  const startSplit = async () => {
    let btn = page.locator(".split-add-btn");
    if (!(await btn.count())) {
      await searchClass(ctx.drClass);
      btn = page.locator(".split-add-btn");
    }
    await btn.first().click();
    await page.locator(".split-box").waitFor({ timeout: 8000 });
    await pause(700);
    const name = page.locator(".split-box input").first();
    await name.fill("");
    await name.pressSequentially("semiconductor-product-subset", { delay: 55 });
    await pause(800);
  };

  /**
   * Fait défiler les règles d'expansion une par une. Chaque bascule change le
   * compteur de classes et la zone allumée dans le graphe : c'est ce qui rend
   * lisible ce que fait chaque option, plutôt que de les subir toutes en bloc.
   */
  const splitOptions = async () => {
    const count = () => page.locator(".split-count").innerText();
    const row = (label) => page.locator(".check-row", { hasText: label });
    const steps = [
      ["descendants seuls", async () => row("Superclasses").locator("input").uncheck()],
      ["+ contexte parent", async () => row("Superclasses").locator("input").check()],
      ["+ 1 saut de propriété", async () =>
        page.locator(".split-hops button", { hasText: "1 hop" }).click()],
      ["+ 2 sauts", async () =>
        page.locator(".split-hops button", { hasText: "2 hops" }).click()],
      ["retour à 1 saut", async () =>
        page.locator(".split-hops button", { hasText: "1 hop" }).click()],
    ];
    for (const [what, act] of steps) {
      await act();
      await pause(1600);
      log(`  split — ${what} : ${(await count()).replace(/\s+/g, " ")}`);
    }
  };

  const exportSplit = async () => {
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }),
      page.locator(".split-export").click(),
    ]);
    const dest = join(OUT, "downloads", dl.suggestedFilename());
    mkdirSync(dirname(dest), { recursive: true });
    await dl.saveAs(dest);
    const kb = Math.max(1, Math.round(statSync(dest).size / 1024));
    await toast(`⬇ ${dl.suggestedFilename()} — ${kb} KB`, 3200);
  };

  const closeSplit = async () => {
    const x = page.locator(".split-close");
    if (await x.count()) await x.first().click();
    await pause(400);
  };

  /**
   * Amène le seuil d'importance à `frac` de sa course, au clavier.
   *
   * Volontairement pas à la souris : un appui près du curseur finissait par
   * traverser jusqu'au canvas et sélectionner une classe, ce qui rallumait
   * l'estompage et ruinait le plan. Au clavier, le graphe n'est jamais touché.
   */
  const slider = async (frac, ms) => {
    const el = page.locator(".threshold-box input[type=range]");
    const { max, value } = await el.evaluate((n) => ({
      max: Number(n.max),
      value: Number(n.value),
    }));
    const target = Math.round(max * frac);
    const steps = Math.abs(target - value);
    if (!steps) return;
    await el.focus();
    const key = target > value ? "ArrowRight" : "ArrowLeft";
    const delay = Math.max(25, ms / steps);
    for (let i = 0; i < steps; i++) {
      await page.keyboard.press(key);
      await pause(delay);
    }
  };

  const setChatContext = async (on) => {
    const chip = page.locator(".ctx-chip:not(.fixed)").first();
    if (!(await chip.count())) {
      console.warn("!! aucune ontologie liée disponible dans le contexte du chat");
      return;
    }
    const active = (await chip.getAttribute("class"))?.includes("on");
    if (active !== on) {
      await chip.click();
      await pause(700);
    }
  };

  const newChat = async () => {
    await page.getByRole("button", { name: /New chat/ }).click();
    await pause(600);
  };

  const ask = async (question) => {
    const before = await page.locator(".chat-msg.assistant").count();
    const input = page.locator(".chat-input");
    await input.click();
    await input.pressSequentially(question, { delay: 26 });
    await pause(500);
    await page.locator(".chat-send").click();
    await page
      .locator(".chat-msg.assistant")
      .nth(before)
      .waitFor({ timeout: 180000 });
    await page
      .locator(".pipeline-live")
      .waitFor({ state: "detached", timeout: 180000 })
      .catch(() => {});
    await pause(1200);
  };

  return {
    page, ctx, fast: FAST,
    caption, toast, pause, endCard, orbit, zoom, scroll, tab, searchClass, importOntology,
    wsAction, wsTab, overlay, unfocus, deselect, pinNode, startSplit, exportSplit,
    splitOptions, closeSplit, slider, setChatContext, newChat, ask,
  };
}

/* ------------------- synchronisation par marqueur visuel ------------------ */

/** Couleurs du carré de synchro : repos, puis alternance à chaque phrase. */
const MARK_IDLE = "rgb(128,128,128)";
const MARK_A = "rgb(255,255,255)";
const MARK_B = "rgb(0,0,0)";
const SAMPLE_HZ = 25;

/**
 * Relit le carré de synchro dans la vidéo pour retrouver l'instant exact où
 * chaque phrase est apparue à l'image. On échantillonne quatre pixels au coin
 * inférieur gauche, on les moyenne, et on classe chaque image en blanc / noir /
 * gris ; les basculements blanc↔noir, dans l'ordre, sont les débuts de beats.
 */
async function detectBeatTimes(videoPath, count) {
  const { stdout } = await exec(
    FFMPEG,
    [
      "-hide_banner", "-loglevel", "error", "-i", videoPath,
      "-vf", `crop=4:4:4:${H - 11},scale=1:1:flags=area,fps=${SAMPLE_HZ}`,
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ],
    { encoding: "buffer", maxBuffer: 1 << 26 }
  );

  const state = [];
  for (let i = 0; i + 2 < stdout.length; i += 3) {
    const v = (stdout[i] + stdout[i + 1] + stdout[i + 2]) / 3;
    state.push(v > 190 ? "A" : v < 65 ? "B" : v > 100 && v < 170 ? "I" : "-");
  }

  // deux échantillons consécutifs pour ignorer une image de transition
  const stable = (i, s) => state[i] === s && state[i + 1] === s;

  // Le coin de la page est blanc tant que le marqueur n'existe pas : sans ce
  // calage sur l'état de repos gris, ce fond serait pris pour le premier beat.
  let from = 0;
  while (from < state.length - 1 && !stable(from, "I")) from++;
  if (from >= state.length - 1) return null;

  const times = [];
  for (let b = 0; b < count; b++) {
    const want = b % 2 === 0 ? "A" : "B";
    let i = from;
    while (i < state.length - 1 && !stable(i, want)) i++;
    if (i >= state.length - 1) break; // fin de vidéo atteinte
    times.push(Math.round((i * 1000) / SAMPLE_HZ));
    from = i + 1;
  }
  // Les toutes dernières phrases peuvent manquer si Playwright a tronqué la
  // fin : mieux vaut les caler par différence que de jeter toute la mesure.
  if (times.length < count / 2) return null;
  return { times, complete: times.length === count };
}

/* ------------------------------ le tournage ----------------------------- */

async function record(tracks) {
  const videoDir = join(WORK, "video");
  rmSync(videoDir, { recursive: true, force: true });
  mkdirSync(videoDir, { recursive: true });

  // Rendu par le GPU : SwiftShader ne tient que ~13 images/s sur ce graphe,
  // ce qui se voit immédiatement pendant les rotations. En ANGLE/OpenGL on
  // sature la cadence d'enregistrement de Playwright (25 img/s).
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-gl=angle",
      "--use-angle=gl",
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--disable-gpu-driver-bug-workarounds",
      "--force-device-scale-factor=1",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    acceptDownloads: true,
    recordVideo: { dir: videoDir, size: { width: W, height: H } },
  });
  const t0 = Date.now(); // origine de la piste vidéo
  const page = await context.newPage();
  page.on("pageerror", (e) => console.warn("!! erreur page :", String(e).slice(0, 160)));

  const h = makeHelpers(page, { ...scenarioMeta });

  await page.goto(`${FRONTEND}/#graph`, { waitUntil: "networkidle" });
  await page.locator("canvas").first().waitFor({ timeout: 60000 });
  await h.caption("", MARK_IDLE); // le marqueur existe avant la première phrase
  await page.waitForTimeout(3500); // le graphe se stabilise à l'image

  const timeline = [];
  for (const [i, b] of beats.entries()) {
    const startMs = Date.now() - t0;
    log(`beat ${i + 1}/${beats.length} — ${b.id} @ ${(startMs / 1000).toFixed(1)} s`);
    await h.caption(b[LANG], i % 2 === 0 ? MARK_A : MARK_B);
    const audioDone = page.waitForTimeout(tracks[i].ms + GAP_MS);
    const action = b.run(h).catch((e) => {
      console.warn(`!! beat « ${b.id} » interrompu : ${e.message}`);
    });
    await Promise.all([audioDone, action]);
    timeline.push({ ...tracks[i], startMs, text: b[LANG] });
  }

  // Playwright perd les dernières secondes en fermant : on lui laisse de la
  // marge pour que la dernière phrase et son marqueur soient bien enregistrés.
  await page.waitForTimeout(2000);
  await h.caption("", MARK_IDLE);
  await page.waitForTimeout(9000);
  const video = page.video();
  await context.close();
  await browser.close();
  const path = await video.path();
  log(`vidéo brute : ${path}`);
  return { path, timeline };
}

/* -------------------------------- montage ------------------------------- */

function srt(timeline) {
  const stamp = (ms) => {
    const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
    const m = String(Math.floor(ms / 60000) % 60).padStart(2, "0");
    const s = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
    return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
  };
  return timeline
    .map((t, i) => `${i + 1}\n${stamp(t.startMs)} --> ${stamp(t.startMs + t.ms)}\n${t.text}\n`)
    .join("\n");
}

async function mux(videoPath, timeline) {
  mkdirSync(dirname(OUTFILE), { recursive: true });
  writeFileSync(OUTFILE.replace(/\.mp4$/, ".srt"), srt(timeline), "utf8");

  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", videoPath];
  const withAudio = !SILENT && timeline.every((t) => t.file);

  if (withAudio) {
    for (const t of timeline) args.push("-i", t.file);
    // chaque phrase est retardée jusqu'à l'instant réel où elle a été affichée
    const delays = timeline
      .map((t, i) => `[${i + 1}:a]adelay=${t.startMs}|${t.startMs}[a${i}]`)
      .join(";");
    const mix = timeline.map((_, i) => `[a${i}]`).join("");
    args.push(
      "-filter_complex",
      `${delays};${mix}amix=inputs=${timeline.length}:normalize=0:dropout_transition=0[aout]`,
      "-map", "0:v:0", "-map", "[aout]",
      "-c:a", "aac", "-b:a", "160k"
    );
  } else {
    args.push("-map", "0:v:0", "-an");
  }

  // coupe la marge de sécurité laissée en fin de tournage
  const last = timeline[timeline.length - 1];
  args.push(
    "-t", ((last.startMs + last.ms + 1800) / 1000).toFixed(2),
    "-c:v", "libx264", "-preset", "slow", "-crf", "20",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", "25",
    OUTFILE
  );
  await exec(FFMPEG, args, { maxBuffer: 1 << 24 });
}

/* --------------------------------- main --------------------------------- */

async function ensureUp(url, what) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
  } catch {
    console.error(`${what} injoignable sur ${url} — lancer ./start.sh d'abord.`);
    process.exit(1);
  }
}

async function main() {
  // Outil de mise au point : relit le marqueur d'une vidéo déjà tournée.
  //   node record.mjs --detect out/demo.mp4
  const probe = arg("detect", null);
  if (probe) {
    const d = await detectBeatTimes(resolve(probe), beats.length);
    console.log(
      d
        ? d.times.map((ms, i) => `${i + 1}. ${(ms / 1000).toFixed(2)} s`).join("\n") +
            `\n(${d.times.length}/${beats.length} lues)`
        : "illisible"
    );
    return;
  }

  await ensureUp(`${BACKEND}/api/health`, "Le backend");
  await ensureUp(FRONTEND, "Le frontend");
  if (!existsSync(FFMPEG)) {
    console.error(`ffmpeg introuvable (${FFMPEG}) — voir demo/README.md`);
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });

  await prepareWorkspace();
  const chatsBefore = new Set((await api("/api/chats")).map((c) => c.id));

  log(`narration ${LANG} (${beats.length} phrases)…`);
  const tracks = await synthesize();

  log("tournage…");
  const { path, timeline } = await record(tracks);

  const detected = await detectBeatTimes(path, timeline.length);
  if (detected) {
    const { times, complete } = detected;
    const drift = times.map((t, i) => t - timeline[i].startMs);
    const s = (ms) => (Math.round(ms / 100) / 10).toFixed(1);
    log(
      `synchro relue à l'image sur ${times.length}/${timeline.length} phrases — ` +
        `dérive de l'horloge : ${s(Math.min(...drift))} à ${s(Math.max(...drift))} s`
    );
    if (!complete)
      console.warn(
        `!! ${timeline.length - times.length} phrase(s) hors de la vidéo : calées par différence`
      );
    const tail = drift[drift.length - 1];
    timeline.forEach((t, i) => (t.startMs = times[i] ?? t.startMs + tail));
  } else {
    console.warn(
      "!! marqueur de synchro illisible : repli sur l'horloge (voix possiblement décalée)"
    );
  }

  log("montage…");
  await mux(path, timeline);

  // les conversations créées par la démo ne restent pas dans l'historique
  for (const c of await api("/api/chats")) {
    if (!chatsBefore.has(c.id))
      await api(`/api/chats/${c.id}`, { method: "DELETE" }).catch(() => {});
  }

  const mb = (statSync(OUTFILE).size / 1048576).toFixed(1);
  const dur = (timeline.at(-1).startMs + timeline.at(-1).ms) / 1000;
  console.log(`\n✔ ${OUTFILE}  (${mb} Mo, ~${Math.round(dur)} s)`);
  console.log(`  sous-titres : ${OUTFILE.replace(/\.mp4$/, ".srt")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
