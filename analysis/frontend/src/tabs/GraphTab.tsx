import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  consumeGraphFocus,
  onGraphFocus,
  stashGraphFocus,
  type GraphFocusRequest,
} from "../bus";

// Cache module : le graphe complet n'est téléchargé qu'une fois, même si
// l'onglet est démonté/remonté (un seul onglet vit à la fois).
let graphCache: BuiltGraph | null = null;
import { fetchGraph, fileUrl } from "../api";
import { toCurie } from "../curie";
import { buildColorMap, NEUTRAL_DARK, NEUTRAL_LIGHT } from "../palette";
import type { BuiltGraph, GraphLink, GraphNode, Meta } from "../types";
import NetworkCanvas, { NetworkCanvasHandle } from "../components/NetworkCanvas";
import NetworkCanvas3D, { NetworkCanvas3DHandle } from "../components/NetworkCanvas3D";

type GroupMode = "lobes" | "modules";
type ViewMode = "3d" | "2d";

const NO_LOBE = "none";

function linkKey(l: GraphLink): string {
  return `${l.type}|${l.iri ?? ""}|${l.source}|${l.target}`;
}

interface Props {
  meta: Meta;
  dark: boolean;
}

export default function GraphTab({ meta, dark }: Props) {
  const [groupMode, setGroupMode] = useState<GroupMode>("lobes");
  const [viewMode, setViewMode] = useState<ViewMode>("3d");
  const [selectedLobes, setSelectedLobes] = useState<Set<string>>(
    () => new Set([...meta.lobes.map((l) => l.id), NO_LOBE])
  );
  const [selectedModules, setSelectedModules] = useState<Set<string>>(
    () => new Set(meta.modules.filter((m) => !m.external).map((m) => m.id))
  );
  const [showSubclass, setShowSubclass] = useState(true);
  const [showProperties, setShowProperties] = useState(true);
  const [minDegree, setMinDegree] = useState(0);
  const [fullGraph, setFullGraph] = useState<BuiltGraph>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLinkKey, setSelectedLinkKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const canvas2dRef = useRef<NetworkCanvasHandle>(null);
  const canvas3dRef = useRef<NetworkCanvas3DHandle>(null);

  /* ---- Focus demandé par le chatbot (nœud ou relation mentionnés) ---- */
  useEffect(() => {
    const ensureVisible = (iri: string) => {
      const n = fullGraph.nodes.find((x) => x.id === iri);
      if (!n) return;
      if (n.degree < minDegree) setMinDegree(0);
      if (groupMode === "lobes") {
        const visible =
          n.lobes.some((l) => selectedLobes.has(l)) ||
          (selectedLobes.has(NO_LOBE) && n.lobes.length === 0);
        if (!visible)
          setSelectedLobes(
            (prev) => new Set([...prev, ...(n.lobes.length ? n.lobes : [NO_LOBE])])
          );
      } else if (!selectedModules.has(n.module)) {
        setSelectedModules((prev) => new Set([...prev, n.module]));
      }
    };
    const apply = (r: GraphFocusRequest) => {
      consumeGraphFocus();
      if (fullGraph.nodes.length === 0) {
        stashGraphFocus(r); // ré-appliquée quand le graphe sera chargé
        return;
      }
      let focusIri: string | null = null;
      if ("iri" in r) {
        ensureVisible(r.iri);
        setSelectedLinkKey(null);
        setSelectedId(r.iri);
        focusIri = r.iri;
      } else {
        const between = fullGraph.links.filter(
          (l) =>
            (l.source === r.from && l.target === r.to) ||
            (l.source === r.to && l.target === r.from)
        );
        const link =
          between.find((l) =>
            r.via === "subClassOf" ? l.type === "subclass" : l.label === r.via
          ) ?? between[0];
        ensureVisible(r.from);
        ensureVisible(r.to);
        if (link) {
          if (!showSubclass && link.type === "subclass") setShowSubclass(true);
          if (!showProperties && link.type === "property") setShowProperties(true);
          setSelectedId(null);
          setSelectedLinkKey(linkKey(link));
          focusIri = link.source;
        } else {
          setSelectedLinkKey(null);
          setSelectedId(r.from);
          focusIri = r.from;
        }
      }
      if (focusIri) {
        const iri = focusIri;
        // Le canvas peut encore être en train de charger/positionner : on
        // réessaie jusqu'à ce que le vol de caméra ait réellement eu lieu.
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          const ok =
            (canvas3dRef.current?.focusNode(iri) ?? false) ||
            (canvas2dRef.current?.focusNode(iri) ?? false);
          if (ok || tries > 25) clearInterval(timer);
        }, 200);
      }
    };
    const pending = consumeGraphFocus();
    if (pending) apply(pending);
    return onGraphFocus(apply);
  }, [fullGraph, groupMode, selectedLobes, selectedModules, minDegree, showSubclass, showProperties]);

  /* ---- Chargement UNIQUE du graphe complet : ensuite tout le filtrage est
     local, donc cocher/décocher retire les nœuds en place, sans rechargement */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (graphCache) {
      setFullGraph(graphCache);
      setLoading(false);
      return;
    }
    fetchGraph({})
      .then((g) => {
        graphCache = g;
        if (!cancelled) setFullGraph(g);
      })
      .catch((e) => console.error(e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---- Filtrage client-side ---- */
  const graph = useMemo(() => {
    const keepNode = (n: GraphNode) =>
      groupMode === "lobes"
        ? n.lobes.some((l) => selectedLobes.has(l)) ||
          (selectedLobes.has(NO_LOBE) && n.lobes.length === 0)
        : selectedModules.has(n.module);
    const nodes = fullGraph.nodes.filter((n) => keepNode(n) && n.degree >= minDegree);
    const kept = new Set(nodes.map((n) => n.id));
    const links = fullGraph.links.filter(
      (l) =>
        kept.has(l.source) &&
        kept.has(l.target) &&
        (l.type === "subclass" ? showSubclass : showProperties)
    );
    return { nodes, links };
  }, [fullGraph, groupMode, selectedLobes, selectedModules, showSubclass, showProperties, minDegree]);

  const maxDegree = useMemo(
    () => Math.min(50, fullGraph.nodes.reduce((m, n) => Math.max(m, n.degree), 0)),
    [fullGraph]
  );

  /* ---- Couleurs par groupe (ordre fixe issu du meta) ---- */
  const lobeOrder = useMemo(() => meta.lobes.map((l) => l.id), [meta]);
  const moduleOrder = useMemo(() => meta.modules.map((m) => m.id), [meta]);
  const colorMap = useMemo(
    () => buildColorMap(groupMode === "lobes" ? lobeOrder : moduleOrder, dark),
    [groupMode, lobeOrder, moduleOrder, dark]
  );
  const neutral = dark ? NEUTRAL_DARK : NEUTRAL_LIGHT;
  const colorOf = useCallback(
    (group: string) => colorMap.get(group) ?? neutral,
    [colorMap, neutral]
  );

  /* ---- Adaptation nœuds/arêtes -> viz ---- */
  const groupOfNode = useCallback(
    (n: GraphNode) => {
      if (groupMode === "modules") return n.module;
      for (const id of lobeOrder) if (n.lobes.includes(id)) return id;
      return NO_LOBE;
    },
    [groupMode, lobeOrder]
  );

  // Données COMPLÈTES passées une seule fois aux canvas : le filtrage se fait
  // par ensembles de visibilité (aucune reconstruction => pas de lag, et les
  // nœuds décochés disparaissent en place).
  const vizNodes = useMemo(
    () =>
      fullGraph.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        group: groupOfNode(n),
        degree: n.degree,
      })),
    [fullGraph, groupOfNode]
  );
  const vizLinks = useMemo(() => {
    const links = fullGraph.links.map((l) => ({
      source: l.source,
      target: l.target,
      kind: l.type,
      label: l.label,
      key: linkKey(l),
      lslot: undefined as number | undefined,
      lflip: false,
      lt: undefined as number | undefined,
    }));
    // Arêtes parallèles (ex. bidirectionnelles) : répartir les labels sur des
    // slots perpendiculaires pour qu'ils ne se chevauchent pas.
    const pairs = new Map<string, number[]>();
    links.forEach((l, i) => {
      const k =
        l.source < l.target
          ? `${l.source}\u0000${l.target}`
          : `${l.target}\u0000${l.source}`;
      if (!pairs.has(k)) pairs.set(k, []);
      pairs.get(k)!.push(i);
    });
    pairs.forEach((idxs) => {
      if (idxs.length < 2) return;
      idxs.forEach((li, j) => {
        const link = links[li];
        link.lslot = j - (idxs.length - 1) / 2;
        link.lflip = link.source > link.target;
        // Répartition LE LONG de l'arête (0.25 → 0.75), en direction
        // canonique de la paire : c'est la vraie garantie anti-chevauchement
        // pour des labels larges.
        const tBase = 0.25 + (0.5 * j) / (idxs.length - 1);
        link.lt = link.lflip ? 1 - tBase : tBase;
      });
    });
    return links;
  }, [fullGraph]);
  const visibleNodeIds = useMemo(
    () => new Set(graph.nodes.map((n) => n.id)),
    [graph]
  );
  const visibleLinkKeys = useMemo(
    () => new Set(graph.links.map(linkKey)),
    [graph]
  );

  const nodeById = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of fullGraph.nodes) m.set(n.id, n);
    return m;
  }, [fullGraph]);

  const selectedNode = selectedId ? (nodeById.get(selectedId) ?? null) : null;
  const selectedLink = useMemo(
    () =>
      selectedLinkKey
        ? (graph.links.find((l) => linkKey(l) === selectedLinkKey) ?? null)
        : null,
    [selectedLinkKey, graph]
  );

  /* ---- Voisins du nœud sélectionné (pour le panneau) ---- */
  const selectedNeighbors = useMemo(() => {
    if (!selectedId) return [];
    const out: { rel: string; dir: "→" | "←"; node: GraphNode }[] = [];
    for (const l of graph.links) {
      if (l.source === selectedId && nodeById.has(l.target)) {
        out.push({ rel: l.label ?? l.type, dir: "→", node: nodeById.get(l.target)! });
      } else if (l.target === selectedId && nodeById.has(l.source)) {
        out.push({ rel: l.label ?? l.type, dir: "←", node: nodeById.get(l.source)! });
      }
    }
    out.sort((a, b) => a.rel.localeCompare(b.rel) || a.node.label.localeCompare(b.node.label));
    return out.slice(0, 80);
  }, [selectedId, graph, nodeById]);

  /* ---- Recherche ---- */
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    return graph.nodes
      .filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 12);
  }, [search, graph]);

  const selectAndFocus = useCallback(
    (id: string) => {
      setSelectedLinkKey(null);
      setSelectedId(id);
      setSearch("");
      setTimeout(() => {
        if (viewMode === "3d") canvas3dRef.current?.focusNode(id);
        else canvas2dRef.current?.focusNode(id);
      }, 50);
    },
    [viewMode]
  );

  /* ---- Groupes affichés dans le panneau ---- */
  const noLobeCount = useMemo(
    () => fullGraph.nodes.filter((n) => n.lobes.length === 0).length,
    [fullGraph]
  );

  const groups =
    groupMode === "lobes"
      ? [
          ...meta.lobes.map((l) => ({
            id: l.id,
            name: l.label,
            count: l.classCount,
            title: l.comment,
          })),
          {
            id: NO_LOBE,
            name: "No lobe",
            count: noLobeCount,
            title: "Classes not attached to any lobe",
          },
        ]
      : meta.modules.map((m) => ({
          id: m.id,
          name: m.id + (m.external ? " (ext.)" : ""),
          count: m.classCount,
          title: m.namespace,
        }));

  const activeSet = groupMode === "lobes" ? selectedLobes : selectedModules;
  const setActiveSet = groupMode === "lobes" ? setSelectedLobes : setSelectedModules;

  const toggleGroup = (id: string) => {
    setActiveSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = useCallback((idOrNull: string | null) => {
    setSelectedId(idOrNull);
  }, []);

  return (
    <div className="graph-layout">
      {/* ------------- Panneau latéral gauche ------------- */}
      <aside className="sidebar">
        <div className="search-box">
          <input
            placeholder="Search for a class…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map((n) => (
                <button key={n.id} onClick={() => selectAndFocus(n.id)}>
                  {n.label}
                  <div className="sub">
                    {toCurie(n.id)} · {n.module}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3>Group by</h3>
          <div className="segmented">
            <button
              className={groupMode === "lobes" ? "active" : ""}
              onClick={() => setGroupMode("lobes")}
            >
              Lobes
            </button>
            <button
              className={groupMode === "modules" ? "active" : ""}
              onClick={() => setGroupMode("modules")}
            >
              Modules
            </button>
          </div>
        </div>

        <div>
          <h3>{groupMode === "lobes" ? "Lobes" : "Modules (namespaces)"}</h3>
          <div className="group-list">
            {groups.map((g) => (
              <label key={g.id} className="group-row" title={g.title ?? undefined}>
                <input
                  type="checkbox"
                  checked={activeSet.has(g.id)}
                  onChange={() => toggleGroup(g.id)}
                />
                <span className="chip" style={{ background: colorOf(g.id) }} />
                <span className="name">{g.name}</span>
                {g.count >= 0 && <span className="count">{g.count}</span>}
              </label>
            ))}
          </div>
          <div className="mini-actions">
            <button onClick={() => setActiveSet(new Set(groups.map((g) => g.id)))}>
              All
            </button>
            <button onClick={() => setActiveSet(new Set())}>None</button>
            {groupMode === "modules" && (
              <button
                onClick={() =>
                  setActiveSet(
                    new Set(meta.modules.filter((m) => !m.external).map((m) => m.id))
                  )
                }
              >
                Internal
              </button>
            )}
          </div>
        </div>

        <div>
          <h3>Edges</h3>
          <label className="check-row">
            <input
              type="checkbox"
              checked={showSubclass}
              onChange={(e) => setShowSubclass(e.target.checked)}
            />
            Hierarchy (subClassOf)
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={showProperties}
              onChange={(e) => setShowProperties(e.target.checked)}
            />
            Object properties
          </label>
        </div>

        <div className="sidebar-footer">
          <div>
            <strong>{meta.ontology.title}</strong> v{meta.ontology.version} ·{" "}
            {meta.ontology.triples.toLocaleString("en-US")} triples
          </div>
          <div style={{ marginTop: 6 }}>
            {meta.files.map((f) => (
              <div key={f.name}>
                <a href={fileUrl(f.name)} download>
                  ⬇ {f.name}
                </a>{" "}
                <span style={{ color: "var(--text-muted)" }}>
                  ({Math.round(f.size / 1024).toLocaleString("en-US")} KB)
                </span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* ------------- Zone graphe ------------- */}
      <div className="graph-main">
        {loading && <div className="loading-overlay">Loading graph…</div>}
        <div className="graph-status">
          {graph.nodes.length.toLocaleString("en-US")} classes ·{" "}
          {graph.links.length.toLocaleString("en-US")} links
          {selectedNode ? ` — selected: ${selectedNode.label}` : ""}
          {selectedLink ? ` — edge: ${selectedLink.label ?? selectedLink.type}` : ""}
        </div>
        {viewMode === "3d" ? (
          <NetworkCanvas3D
            ref={canvas3dRef}
            nodes={vizNodes}
            links={vizLinks}
            colorOf={colorOf}
            dark={dark}
            selectedId={selectedId}
            selectedLinkKey={selectedLinkKey}
            onSelect={clearSelection}
            onSelectLink={setSelectedLinkKey}
            visibleNodeIds={visibleNodeIds}
            visibleLinkKeys={visibleLinkKeys}
          />
        ) : (
          <NetworkCanvas
            ref={canvas2dRef}
            nodes={vizNodes}
            links={vizLinks}
            colorOf={colorOf}
            dark={dark}
            selectedId={selectedId}
            selectedLinkKey={selectedLinkKey}
            onSelect={clearSelection}
            onSelectLink={setSelectedLinkKey}
            visibleNodeIds={visibleNodeIds}
            visibleLinkKeys={visibleLinkKeys}
          />
        )}
        <div className="view-switch" role="tablist" aria-label="View mode">
          <button
            role="tab"
            aria-selected={viewMode === "3d"}
            className={viewMode === "3d" ? "active" : ""}
            onClick={() => setViewMode("3d")}
          >
            3D
          </button>
          <button
            role="tab"
            aria-selected={viewMode === "2d"}
            className={viewMode === "2d" ? "active" : ""}
            onClick={() => setViewMode("2d")}
          >
            2D
          </button>
        </div>
        <div
          className="threshold-box"
          title="Hide nodes with fewer connections than the threshold"
        >
          <span className="thr-label">
            Importance ≥ {minDegree}
            <span className="thr-count">
              {graph.nodes.length.toLocaleString("en-US")} shown
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={maxDegree}
            step={1}
            value={minDegree}
            onChange={(e) => setMinDegree(Number(e.target.value))}
          />
        </div>
      </div>

      {/* ------------- Panneau de détails ------------- */}
      <aside className="details-panel">
        {selectedLink ? (
          <>
            <h2>{selectedLink.label ?? "subClassOf"}</h2>
            {selectedLink.iri && (
              <div className="curie" title={selectedLink.iri}>
                {toCurie(selectedLink.iri)}
              </div>
            )}
            <div className="badge-row">
              <span className="badge">
                {selectedLink.type === "subclass"
                  ? "hierarchy (rdfs:subClassOf)"
                  : "object property"}
              </span>
            </div>
            <h4>Domain → Range</h4>
            <button
              className="neighbor-btn"
              onClick={() => selectAndFocus(selectedLink.source)}
            >
              <span className="neighbor-rel">from </span>
              {nodeById.get(selectedLink.source)?.label ?? selectedLink.source}
            </button>
            <button
              className="neighbor-btn"
              onClick={() => selectAndFocus(selectedLink.target)}
            >
              <span className="neighbor-rel">to </span>
              {nodeById.get(selectedLink.target)?.label ?? selectedLink.target}
            </button>
          </>
        ) : selectedNode ? (
          <>
            <h2>{selectedNode.label}</h2>
            <div className="curie" title={selectedNode.id}>
              {toCurie(selectedNode.id)}
            </div>
            <div className="badge-row">
              <span className="badge">
                <span className="chip" style={{ background: colorOf(selectedNode.module) }} />
                module {selectedNode.module}
              </span>
              {selectedNode.lobes.map((l) => (
                <span key={l} className="badge">
                  <span
                    className="chip"
                    style={{
                      background: groupMode === "lobes" ? colorOf(l) : "var(--text-muted)",
                    }}
                  />
                  {meta.lobes.find((x) => x.id === l)?.label ?? l}
                </span>
              ))}
            </div>
            {selectedNode.comment && <p className="comment">{selectedNode.comment}</p>}

            {selectedNode.attributes.length > 0 && (
              <>
                <h4>Attributes ({selectedNode.attributes.length})</h4>
                <table className="attr-table">
                  <tbody>
                    {selectedNode.attributes.map((a) => (
                      <tr key={a.iri} title={a.iri}>
                        <td>{a.label}</td>
                        <td>{a.range ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {selectedNeighbors.length > 0 && (
              <>
                <h4>Relations ({selectedNeighbors.length})</h4>
                {selectedNeighbors.map((nb, i) => (
                  <button
                    key={i}
                    className="neighbor-btn"
                    onClick={() => selectAndFocus(nb.node.id)}
                    title={`${nb.rel} ${nb.dir} ${nb.node.label}`}
                  >
                    <span className="neighbor-rel">
                      {nb.dir} {nb.rel} ·{" "}
                    </span>
                    {nb.node.label}
                  </button>
                ))}
              </>
            )}
          </>
        ) : (
          <div className="empty-hint">
            Click a class or an edge in the graph to see its details,
            <br />
            or search for a class in the left panel.
          </div>
        )}
      </aside>
    </div>
  );
}
