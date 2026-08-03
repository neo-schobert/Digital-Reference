import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { db, DATA_DIR } from "./chatstore.js";
import {
  extOf,
  extractPrefixes,
  loadStore,
  ontologyIdentity,
  parseClasses,
} from "./rdf.js";

/* ------------------------------------------------------------------ */
/* Projets                                                             */
/*                                                                     */
/* Un projet = UNE ontologie de référence + les ontologies importées   */
/* qu'on lui compare. Chaque ontologie peut déclarer des dépendances   */
/* (d'autres ontologies du même projet) : la référence est chargée     */
/* avec la fermeture de ses dépendances, exactement comme le Digital   */
/* Reference l'est avec SOSA / SSN / Time.                             */
/*                                                                     */
/* Sans référence, un projet n'a ni graphe, ni SPARQL, ni chatbot, ni  */
/* mapping : tout le métier en aval part de `referenceFiles()`.        */
/* ------------------------------------------------------------------ */

export const WS_DIR = join(DATA_DIR, "workspace");
mkdirSync(WS_DIR, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    reference_id TEXT
  );
  CREATE TABLE IF NOT EXISTS ws_ontologies (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    filename    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    triples     INTEGER NOT NULL,
    classes     INTEGER NOT NULL,
    properties  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ws_results (
    onto_id     TEXT NOT NULL,
    kind        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    data        TEXT NOT NULL,
    PRIMARY KEY (onto_id, kind)
  );
`);

/* Migration douce : les colonnes projet sont ajoutées aux tables déjà
   créées par les versions précédentes (workspace plat, chats globaux). */
function addColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
addColumn("ws_ontologies", "project_id", "TEXT");
addColumn("ws_ontologies", "deps", "TEXT NOT NULL DEFAULT '[]'");
addColumn("ws_ontologies", "onto_iri", "TEXT");
addColumn("ws_ontologies", "namespaces", "TEXT NOT NULL DEFAULT '[]'");
addColumn("ws_ontologies", "prefixes", "TEXT NOT NULL DEFAULT '{}'");
addColumn("chats", "project_id", "TEXT");

db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

function appMeta(key: string): string | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setAppMeta(key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export const VALID_ID = /^[A-Za-z0-9-]{8,64}$/;

/* ------------------------------- Types ------------------------------ */

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  /** id de l'ontologie servant de référence, null tant qu'aucune n'est choisie */
  referenceId: string | null;
  referenceName: string | null;
  /** true dès qu'une comparaison ou un mapping existe : la référence (et
      ses dépendances) ne peuvent plus changer, tous les résultats sont
      calculés contre elle. */
  referenceLocked: boolean;
  ontologyCount: number;
  chatCount: number;
}

export interface ProjectOntology {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  triples: number;
  classes: number;
  properties: number;
  /** ids des ontologies du projet dont celle-ci dépend */
  deps: string[];
  isReference: boolean;
  /** true si l'ontologie fait partie de la référence : elle-même ou une de
      ses dépendances (transitives) — elle est donc déjà chargée avec elle. */
  inReference: boolean;
  ontologyIri?: string;
  namespaces: string[];
  hasCompare: boolean;
  hasMapping: boolean;
  linkScore?: number;
  similarityScore?: number;
}

interface OntoRow {
  id: string;
  project_id: string | null;
  name: string;
  filename: string;
  created_at: number;
  triples: number;
  classes: number;
  properties: number;
  deps: string;
  onto_iri: string | null;
  namespaces: string;
  prefixes: string;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  created_at: number;
  reference_id: string | null;
}

/* ---------------------------- Résultats ----------------------------- */

export function getResult(ontologyId: string, kind: string): unknown | null {
  const row = db
    .prepare(`SELECT data FROM ws_results WHERE onto_id = ? AND kind = ?`)
    .get(ontologyId, kind) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : null;
}

/** Nombre de comparaisons / mappings déjà calculés dans un projet. */
export function projectResultCount(projectId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ws_results
        WHERE onto_id IN (SELECT id FROM ws_ontologies WHERE project_id = ?)`
    )
    .get(projectId) as { n: number };
  return Number(row.n);
}

export function saveResult(ontologyId: string, kind: string, data: unknown): void {
  db.prepare(
    `INSERT INTO ws_results (onto_id, kind, created_at, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(onto_id, kind) DO UPDATE SET created_at = excluded.created_at, data = excluded.data`
  ).run(ontologyId, kind, Date.now(), JSON.stringify(data));
}

/* --------------------------- Lecture DB ----------------------------- */

const jsonArray = (raw: string | null): string[] => {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const jsonObject = (raw: string | null): Record<string, string> => {
  try {
    const v = JSON.parse(raw ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
};

function ontoRow(id: string): OntoRow | undefined {
  if (!VALID_ID.test(id)) return undefined;
  return db.prepare(`SELECT * FROM ws_ontologies WHERE id = ?`).get(id) as
    | OntoRow
    | undefined;
}

/**
 * Ontologies constituant la référence d'un projet : la référence elle-même
 * et la fermeture transitive de ses dépendances. Elles sont chargées avec
 * elle — on ne peut donc ni les comparer ni les mapper à la référence, et
 * le graphe ne les propose pas en couche : elles y sont déjà.
 */
export function referenceClosure(projectId: string): Set<string> {
  const row = db
    .prepare(`SELECT reference_id FROM projects WHERE id = ?`)
    .get(projectId) as { reference_id: string | null } | undefined;
  const out = new Set<string>();
  if (!row?.reference_id) return out;
  const stack = [row.reference_id];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    const r = ontoRow(id);
    if (!r) continue;
    out.add(id);
    for (const dep of jsonArray(r.deps)) stack.push(dep);
  }
  return out;
}

function toOntology(
  r: OntoRow,
  referenceId: string | null,
  closure: Set<string>
): ProjectOntology {
  const mapping = getResult(r.id, "mapping") as
    | { linkScore?: number }
    | null;
  const compare = getResult(r.id, "compare") as
    | { similarityScore?: number }
    | null;
  return {
    id: r.id,
    projectId: r.project_id ?? "",
    name: r.name,
    createdAt: r.created_at,
    triples: r.triples,
    classes: r.classes,
    properties: r.properties,
    deps: jsonArray(r.deps),
    isReference: r.id === referenceId,
    inReference: closure.has(r.id),
    ontologyIri: r.onto_iri ?? undefined,
    namespaces: jsonArray(r.namespaces),
    hasCompare: compare !== null,
    hasMapping: mapping !== null,
    linkScore: mapping?.linkScore,
    similarityScore: compare?.similarityScore,
  };
}

export function listProjects(): Project[] {
  const rows = db
    .prepare(`SELECT * FROM projects ORDER BY created_at ASC`)
    .all() as ProjectRow[];
  return rows.map((p) => {
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM ws_ontologies WHERE project_id = ?`)
      .get(p.id) as { n: number };
    const chats = db
      .prepare(`SELECT COUNT(*) AS n FROM chats WHERE project_id = ?`)
      .get(p.id) as { n: number };
    const refName = p.reference_id
      ? (
          db
            .prepare(`SELECT name FROM ws_ontologies WHERE id = ?`)
            .get(p.reference_id) as { name: string } | undefined
        )?.name ?? null
      : null;
    return {
      id: p.id,
      name: p.name,
      description: p.description ?? "",
      createdAt: p.created_at,
      referenceId: refName ? p.reference_id : null,
      referenceName: refName,
      referenceLocked: projectResultCount(p.id) > 0,
      ontologyCount: Number(count.n),
      chatCount: Number(chats.n),
    };
  });
}

export function getProject(id: string): Project | null {
  if (!VALID_ID.test(id)) return null;
  return listProjects().find((p) => p.id === id) ?? null;
}

export function requireProject(id: string): Project {
  const p = getProject(id);
  if (!p) throw new HttpError(404, `Unknown project: ${id}`);
  return p;
}

export function listOntologies(projectId: string): ProjectOntology[] {
  const project = requireProject(projectId);
  const rows = db
    .prepare(
      `SELECT * FROM ws_ontologies WHERE project_id = ? ORDER BY created_at ASC`
    )
    .all(projectId) as OntoRow[];
  const closure = referenceClosure(projectId);
  return rows.map((r) => toOntology(r, project.referenceId, closure));
}

export function getOntology(id: string): ProjectOntology | null {
  const r = ontoRow(id);
  if (!r) return null;
  const project = r.project_id ? getProject(r.project_id) : null;
  return toOntology(
    r,
    project?.referenceId ?? null,
    project ? referenceClosure(project.id) : new Set<string>()
  );
}

/**
 * Une fois qu'une comparaison ou un mapping a été calculé, la référence du
 * projet est FIGÉE : tous les résultats (scores, axiomes SKOS, fichiers
 * mappés) pointent vers ses IRIs. En changer — ou toucher à ses dépendances,
 * qui en font partie — les rendrait silencieusement faux.
 */
function assertReferenceUnlocked(projectId: string, what: string): void {
  const n = projectResultCount(projectId);
  if (n === 0) return;
  throw new HttpError(
    409,
    `The reference of this project is frozen: ${n} comparison/mapping result${
      n > 1 ? "s have" : " has"
    } already been computed against it, so ${what} would invalidate them. ` +
      "Delete the aligned ontologies (their results go with them) to unfreeze it."
  );
}

/** Erreur portant un code HTTP : les routes la traduisent telle quelle. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/* ---------------------------- Écriture ------------------------------ */

export function createProject(
  id: string,
  name: string,
  description = ""
): Project {
  if (!VALID_ID.test(id)) throw new HttpError(400, "Invalid project id");
  const clean = name.trim();
  if (!clean) throw new HttpError(400, "A project name is required");
  db.prepare(
    `INSERT INTO projects (id, name, description, created_at, reference_id)
     VALUES (?, ?, ?, ?, NULL)`
  ).run(id, clean, description.trim(), Date.now());
  return getProject(id)!;
}

export function updateProject(
  id: string,
  patch: { name?: string; description?: string; referenceId?: string | null }
): Project {
  const project = requireProject(id);
  if (patch.name !== undefined) {
    const clean = patch.name.trim();
    if (!clean) throw new HttpError(400, "A project name is required");
    db.prepare(`UPDATE projects SET name = ? WHERE id = ?`).run(clean, id);
  }
  if (patch.description !== undefined) {
    db.prepare(`UPDATE projects SET description = ? WHERE id = ?`).run(
      patch.description.trim(),
      id
    );
  }
  if (patch.referenceId !== undefined && patch.referenceId !== project.referenceId) {
    if (patch.referenceId !== null) {
      const row = ontoRow(patch.referenceId);
      if (!row || row.project_id !== id)
        throw new HttpError(400, "The reference must be an ontology of this project");
    }
    assertReferenceUnlocked(id, "changing the reference");
    db.prepare(`UPDATE projects SET reference_id = ? WHERE id = ?`).run(
      patch.referenceId,
      id
    );
    onReferenceChanged(id);
  }
  return getProject(id)!;
}

export function deleteProject(id: string): boolean {
  const project = getProject(id);
  if (!project) return false;
  for (const o of listOntologies(id)) removeOntologyFiles(o.id);
  db.prepare(
    `DELETE FROM ws_results WHERE onto_id IN (SELECT id FROM ws_ontologies WHERE project_id = ?)`
  ).run(id);
  db.prepare(`DELETE FROM ws_ontologies WHERE project_id = ?`).run(id);
  db.prepare(`DELETE FROM chats WHERE project_id = ?`).run(id);
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  onReferenceChanged(id);
  return true;
}

/* Invalidation des caches en aval (graphe de référence, index chatbot).
   Les modules concernés s'enregistrent ici pour éviter un cycle d'import. */
type Listener = (projectId: string) => void;
const listeners: Listener[] = [];

export function onProjectInvalidated(fn: Listener): void {
  listeners.push(fn);
}

export function onReferenceChanged(projectId: string): void {
  for (const fn of listeners) fn(projectId);
}

export function importOntology(
  projectId: string,
  id: string,
  name: string,
  content: string,
  opts: { deps?: string[] } = {}
): ProjectOntology {
  requireProject(projectId);
  if (!VALID_ID.test(id)) throw new HttpError(400, "Invalid ontology id");
  const ext = extOf(name);
  let store;
  try {
    store = loadStore(content, ext);
  } catch (e) {
    throw new HttpError(
      400,
      `This file could not be parsed as RDF (${e instanceof Error ? e.message : String(e)})`
    );
  }
  if (store.size === 0) throw new HttpError(400, "This file contains no RDF triples");
  const { classes, propertyCount } = parseClasses(store);
  const identity = ontologyIdentity(store);
  const filename = `${id}.${ext}`;
  writeFileSync(join(WS_DIR, filename), content, "utf8");
  db.prepare(
    `INSERT INTO ws_ontologies
       (id, project_id, name, filename, created_at, triples, classes, properties, deps, onto_iri, namespaces, prefixes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    projectId,
    name,
    filename,
    Date.now(),
    store.size,
    classes.length,
    propertyCount,
    JSON.stringify(sanitizeDeps(projectId, id, opts.deps ?? [])),
    identity.ontologyIri ?? null,
    JSON.stringify(identity.namespaces),
    JSON.stringify(extractPrefixes(content))
  );
  onReferenceChanged(projectId);
  return getOntology(id)!;
}

/** Dépendances valides : ontologies du même projet, sans auto-référence. */
function sanitizeDeps(projectId: string, ontologyId: string, deps: string[]): string[] {
  const inProject = new Set(
    (
      db
        .prepare(`SELECT id FROM ws_ontologies WHERE project_id = ?`)
        .all(projectId) as { id: string }[]
    ).map((r) => r.id)
  );
  return [...new Set(deps)].filter((d) => d !== ontologyId && inProject.has(d));
}

export function setDeps(ontologyId: string, deps: string[]): ProjectOntology {
  const row = ontoRow(ontologyId);
  if (!row || !row.project_id) throw new HttpError(404, "Unknown ontology");
  const clean = sanitizeDeps(row.project_id, ontologyId, deps);
  const before = jsonArray(row.deps);
  const changed =
    clean.length !== before.length || clean.some((d) => !before.includes(d));
  if (changed && referenceClosure(row.project_id).has(ontologyId))
    assertReferenceUnlocked(row.project_id, "changing what the reference loads");
  db.prepare(`UPDATE ws_ontologies SET deps = ? WHERE id = ?`).run(
    JSON.stringify(clean),
    ontologyId
  );
  onReferenceChanged(row.project_id);
  return getOntology(ontologyId)!;
}

export function renameOntology(ontologyId: string, name: string): ProjectOntology {
  const row = ontoRow(ontologyId);
  if (!row) throw new HttpError(404, "Unknown ontology");
  const clean = name.trim();
  if (!clean) throw new HttpError(400, "A name is required");
  db.prepare(`UPDATE ws_ontologies SET name = ? WHERE id = ?`).run(clean, ontologyId);
  if (row.project_id) onReferenceChanged(row.project_id);
  return getOntology(ontologyId)!;
}

function removeOntologyFiles(id: string): void {
  const row = ontoRow(id);
  const names = [`${id}-mapped.ttl`, `${id}-mappings.sssom.tsv`];
  if (row) names.push(row.filename);
  for (const f of names) {
    try {
      if (existsSync(join(WS_DIR, f))) unlinkSync(join(WS_DIR, f));
    } catch {
      /* fichier fantôme : la ligne DB part quand même */
    }
  }
}

export function deleteOntology(id: string): boolean {
  const row = ontoRow(id);
  if (!row) return false;
  if (row.project_id && referenceClosure(row.project_id).has(id))
    assertReferenceUnlocked(row.project_id, "removing part of the reference");
  removeOntologyFiles(id);
  db.prepare(`DELETE FROM ws_results WHERE onto_id = ?`).run(id);
  db.prepare(`DELETE FROM ws_ontologies WHERE id = ?`).run(id);
  if (row.project_id) {
    // Elle disparaît des dépendances des autres et, le cas échéant, du rôle
    // de référence : un projet ne reste jamais accroché à une ontologie morte.
    db.prepare(
      `UPDATE projects SET reference_id = NULL WHERE reference_id = ?`
    ).run(id);
    for (const other of db
      .prepare(`SELECT id, deps FROM ws_ontologies WHERE project_id = ?`)
      .all(row.project_id) as { id: string; deps: string }[]) {
      const deps = jsonArray(other.deps);
      if (deps.includes(id)) {
        db.prepare(`UPDATE ws_ontologies SET deps = ? WHERE id = ?`).run(
          JSON.stringify(deps.filter((d) => d !== id)),
          other.id
        );
      }
    }
    onReferenceChanged(row.project_id);
  }
  return true;
}

/* ----------------------------- Fichiers ----------------------------- */

export interface OntologyFile {
  ontologyId: string;
  name: string;
  path: string;
  size: number;
  role: "reference" | "dependency";
  prefixes: Record<string, string>;
  namespaces: string[];
  ontologyIri?: string;
}

export function ontologyPath(id: string): string | null {
  const row = ontoRow(id);
  if (!row) return null;
  const p = join(WS_DIR, row.filename);
  return existsSync(p) ? p : null;
}

export function ontologySource(id: string): { content: string; ext: string; name: string } {
  const row = ontoRow(id);
  if (!row) throw new HttpError(404, "Unknown ontology");
  const path = join(WS_DIR, row.filename);
  if (!existsSync(path)) throw new HttpError(410, `Missing file for ${row.name}`);
  return {
    content: readFileSync(path, "utf8"),
    ext: extOf(row.filename),
    name: row.name,
  };
}

/**
 * Fichiers composant la référence d'un projet : l'ontologie de référence
 * puis la fermeture (transitive, tolérante aux cycles) de ses dépendances.
 */
export function referenceFiles(projectId: string): OntologyFile[] {
  const project = requireProject(projectId);
  if (!project.referenceId) return [];
  const out: OntologyFile[] = [];
  const seen = new Set<string>();
  const queue: { id: string; role: "reference" | "dependency" }[] = [
    { id: project.referenceId, role: "reference" },
  ];
  while (queue.length > 0) {
    const { id, role } = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = ontoRow(id);
    if (!row) continue;
    const path = join(WS_DIR, row.filename);
    if (existsSync(path)) {
      out.push({
        ontologyId: id,
        name: row.name,
        path,
        size: statSync(path).size,
        role,
        prefixes: jsonObject(row.prefixes),
        namespaces: jsonArray(row.namespaces),
        ontologyIri: row.onto_iri ?? undefined,
      });
    }
    for (const dep of jsonArray(row.deps)) queue.push({ id: dep, role: "dependency" });
  }
  return out;
}

/* ------------------- Amorçage : le DR comme projet ------------------ */

const DR_ROOT = resolve(
  process.env.DR_ROOT ?? join(import.meta.dirname, "..", "..", "..")
);

function seedId(suffix: string): string {
  return `seed-${suffix}`.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 64).padEnd(8, "0");
}

/* Identité stockée (namespaces / IRI / préfixes) : la façon de la calculer
   peut évoluer, on la recalcule alors une fois pour les fichiers déjà
   importés plutôt que de demander une ré-importation. */
const IDENTITY_VERSION = "3";

function refreshIdentities(): void {
  if (appMeta("identityVersion") === IDENTITY_VERSION) return;
  const rows = db.prepare(`SELECT id, filename FROM ws_ontologies`).all() as {
    id: string;
    filename: string;
  }[];
  let done = 0;
  for (const r of rows) {
    const path = join(WS_DIR, r.filename);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf8");
      const store = loadStore(content, extOf(r.filename));
      const identity = ontologyIdentity(store);
      db.prepare(
        `UPDATE ws_ontologies SET onto_iri = ?, namespaces = ?, prefixes = ? WHERE id = ?`
      ).run(
        identity.ontologyIri ?? null,
        JSON.stringify(identity.namespaces),
        JSON.stringify(extractPrefixes(content)),
        r.id
      );
      done++;
    } catch (e) {
      console.warn(`[projects] identité non recalculée (${r.filename}): ${(e as Error).message}`);
    }
  }
  setAppMeta("identityVersion", IDENTITY_VERSION);
  if (done > 0) console.log(`[projects] identité recalculée pour ${done} ontologies`);
}

/**
 * Premier démarrage : le Digital Reference du dépôt devient un projet
 * ordinaire (référence + ses dépendances). Les ontologies importées et les
 * conversations d'avant les projets lui sont rattachées, rien n'est perdu.
 */
export function seedDefaultProject(): void {
  refreshIdentities();
  const orphanOntologies = db
    .prepare(`SELECT COUNT(*) AS n FROM ws_ontologies WHERE project_id IS NULL`)
    .get() as { n: number };
  const orphanChats = db
    .prepare(`SELECT COUNT(*) AS n FROM chats WHERE project_id IS NULL`)
    .get() as { n: number };
  const projects = listProjects();
  const mainTtl = join(DR_ROOT, "DigitalReference.ttl");
  const depsDir = join(DR_ROOT, "dependencies");

  if (projects.length > 0) {
    // Projets déjà présents : ne rattacher que d'éventuels orphelins.
    if (Number(orphanOntologies.n) > 0 || Number(orphanChats.n) > 0) {
      adoptOrphans(projects[0].id);
    }
    return;
  }
  if (!existsSync(mainTtl)) {
    console.log(
      "[projects] aucun projet et pas de DigitalReference.ttl : démarrage à vide"
    );
    return;
  }

  const t0 = Date.now();
  const projectId = seedId("digital-reference");
  createProject(
    projectId,
    "Digital Reference",
    "Ontologie OWL des chaînes d'approvisionnement du semi-conducteur (projet créé automatiquement à partir du dépôt)."
  );

  const depIds: string[] = [];
  if (existsSync(depsDir)) {
    for (const f of readdirSync(depsDir)
      .filter((f) => /\.(ttl|n3|nt|rdf|owl|xml)$/i.test(f))
      .sort()) {
      const id = seedId(`dep-${f.replace(/\.[^.]+$/, "")}`);
      try {
        importOntology(projectId, id, f, readFileSync(join(depsDir, f), "utf8"));
        depIds.push(id);
      } catch (e) {
        console.warn(`[projects] dépendance ignorée (${f}): ${(e as Error).message}`);
      }
    }
  }
  const refId = seedId("digital-reference-ttl");
  importOntology(
    projectId,
    refId,
    "DigitalReference.ttl",
    readFileSync(mainTtl, "utf8"),
    { deps: depIds }
  );
  updateProject(projectId, { referenceId: refId });
  adoptOrphans(projectId);
  console.log(
    `[projects] projet « Digital Reference » créé (${depIds.length} dépendances) en ${Date.now() - t0} ms`
  );
}

function adoptOrphans(projectId: string): void {
  const o = db
    .prepare(`UPDATE ws_ontologies SET project_id = ? WHERE project_id IS NULL`)
    .run(projectId);
  const c = db
    .prepare(`UPDATE chats SET project_id = ? WHERE project_id IS NULL`)
    .run(projectId);
  if (Number(o.changes) > 0 || Number(c.changes) > 0) {
    console.log(
      `[projects] rattachés au projet ${projectId}: ${o.changes} ontologies, ${c.changes} conversations`
    );
  }
}

