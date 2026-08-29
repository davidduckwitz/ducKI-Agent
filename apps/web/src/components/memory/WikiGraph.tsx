import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { Compass, Minus, Plus, Sparkles, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";

interface ActivationNode {
  id: string;
  activation: number;
  hopDistance: number;
  matchedSeed: boolean;
}

// Warmer per-hop the closer to a seed, cooling off with distance - a visual echo of
// the activation decay itself, not an arbitrary palette.
const HOP_COLORS = ["#f97316", "#fb923c", "#fdba74", "#fed7aa"];

interface GraphNodeData {
  id: string;
  title: string;
  status: string;
  tags: string[];
  degree: number;
  kind?: "note" | "folder";
}

interface GraphEdgeData {
  id: number | string;
  source: string;
  target: string;
  origin: "parsed" | "manual" | "folder";
  resolved: boolean;
}

type SimNode = SimulationNodeDatum & GraphNodeData;
type SimLink = SimulationLinkDatum<SimNode> & Pick<GraphEdgeData, "id" | "origin" | "resolved">;

const STATUS_COLOR: Record<string, string> = {
  approved: "#34d399",
  candidate: "#fbbf24",
  rejected: "#f87171",
  error: "#f87171",
  folder: "#a78bfa",
};

function nodeRadius(node: GraphNodeData): number {
  if (node.kind === "folder") return 7 + Math.min(node.degree, 20) * 1.3;
  const base = isEntryPoint(node.id) ? 13 : 9;
  return base + Math.min(node.degree, 12) * 2.1;
}

/** The wiki-index skill maintains exactly this note as the graph's Map-of-Content entry point. */
function isEntryPoint(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized === "index.md" || normalized.endsWith("/index.md");
}

function nodeAt(nodes: SimNode[], x: number, y: number, activationById?: Map<string, { activation: number }>): SimNode | undefined {
  let best: SimNode | undefined;
  let bestDist = Infinity;
  for (const node of nodes) {
    if (activationById && activationById.size > 0 && !activationById.has(node.id)) continue;
    const nx = node.x ?? 0;
    const ny = node.y ?? 0;
    const activation = activationById?.get(node.id);
    const r = (activation ? 8 + activation.activation * 20 : nodeRadius(node)) + 4;
    const dist = Math.hypot(nx - x, ny - y);
    if (dist <= r && dist < bestDist) {
      best = node;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Obsidian-style force-directed graph over the LLM-wiki link table: node size by
 * degree, hover dims unrelated nodes/edges, dashed edges for unresolved [[links]].
 * Selecting a node opens a panel that can add/remove connections directly against
 * the llm_wiki_links table (see apps/server/src/routes/wiki.ts /graph, /links).
 */
export function WikiGraph() {
  const qc = useQueryClient();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const draggingRef = useRef<SimNode | null>(null);
  const panningRef = useRef<{ startX: number; startY: number; origin: { x: number; y: number; k: number } } | null>(null);
  const hoveredRef = useRef<string | null>(null);

  const [width, setWidth] = useState(800);
  const height = 520;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addTarget, setAddTarget] = useState("");
  const [activationQuery, setActivationQuery] = useState("");
  const [activationResult, setActivationResult] = useState<ActivationNode[] | null>(null);

  const graphQuery = useQuery({
    queryKey: ["wiki", "graph"],
    queryFn: () => api.wiki.graph(),
    refetchInterval: 30000,
  });

  const createLink = useMutation({
    mutationFn: ({ sourceFile, targetFile }: { sourceFile: string; targetFile: string }) => api.wiki.createLink(sourceFile, targetFile),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["wiki", "graph"] });
      setAddTarget("");
    },
  });

  const deleteLink = useMutation({
    mutationFn: (id: number) => api.wiki.deleteLink(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["wiki", "graph"] });
    },
  });

  // Activation mode calls the exact same /api/wiki/expand endpoint the agent's `wiki`
  // tool uses (LlmWikiService.expand) - the graph then shows precisely what a
  // spreading-activation read of the memory would surface, not a separate UI-side
  // approximation of it.
  const expand = useMutation({
    mutationFn: (params: { query?: string; seedIds?: string[] }) => api.wiki.expand(params),
    onSuccess: (data) => setActivationResult(data.nodes),
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(320, entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const nodes = graphQuery.data?.nodes ?? [];
  const edges = graphQuery.data?.edges ?? [];
  // There can be several index.md files now - one at the wiki root, one per subfolder
  // (see the wiki-index skill). The jump button prioritizes the root one since that's
  // the top-level entry point; per-folder indexes are still starred in the graph and
  // reachable normally (click, or "von hier erschliessen" from any note in that folder).
  const entryPointNode = useMemo(() => {
    const entryPoints = nodes.filter((n) => isEntryPoint(n.id));
    return entryPoints.find((n) => n.id.toLowerCase() === "index.md") ?? entryPoints[0] ?? null;
  }, [nodes]);

  const activationById = useMemo(() => {
    const map = new Map<string, ActivationNode>();
    for (const n of activationResult ?? []) map.set(n.id, n);
    return map;
  }, [activationResult]);

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId]);
  const outgoing = useMemo(() => edges.filter((e) => e.source === selectedId), [edges, selectedId]);
  const incoming = useMemo(() => edges.filter((e) => e.target === selectedId && e.source !== selectedId), [edges, selectedId]);
  // Folder nodes are derived, not real wiki entries - manual links only make sense
  // between actual notes.
  const otherNodes = useMemo(() => nodes.filter((n) => n.id !== selectedId && n.kind !== "folder"), [nodes, selectedId]);

  // (Re)build the simulation whenever the underlying graph data changes. Existing
  // node positions are preserved by id so a refetch after a link edit doesn't reset
  // the whole layout.
  useEffect(() => {
    const prevById = new Map(nodesRef.current.map((n) => [n.id, n]));
    const simNodes: SimNode[] = nodes.map((n) => {
      const prev = prevById.get(n.id);
      return prev ? { ...prev, ...n } : { ...n, x: width / 2 + (Math.random() - 0.5) * 100, y: height / 2 + (Math.random() - 0.5) * 100 };
    });
    const simNodeById = new Map(simNodes.map((n) => [n.id, n]));
    const simLinks: SimLink[] = edges
      .filter((e) => simNodeById.has(e.source) && simNodeById.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, id: e.id, origin: e.origin, resolved: e.resolved }));

    nodesRef.current = simNodes;
    linksRef.current = simLinks;

    simRef.current?.stop();
    const sim = forceSimulation(simNodes)
      .force("link", forceLink<SimNode, SimLink>(simLinks).id((d) => d.id).distance(120).strength(0.5))
      .force("charge", forceManyBody().strength(-260))
      .force("center", forceCenter(width / 2, height / 2))
      .force("collide", forceCollide<SimNode>((d) => nodeRadius(d) + 8))
      .on("tick", draw);
    simRef.current = sim;

    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, width]);

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(transformRef.current.x, transformRef.current.y);
    ctx.scale(transformRef.current.k, transformRef.current.k);

    const activationMode = activationById.size > 0;
    const hovered = hoveredRef.current ?? selectedId;
    const neighborIds = new Set<string>();
    if (!activationMode && hovered) {
      for (const link of linksRef.current) {
        const s = typeof link.source === "object" ? link.source.id : link.source;
        const t = typeof link.target === "object" ? link.target.id : link.target;
        if (s === hovered) neighborIds.add(String(t));
        if (t === hovered) neighborIds.add(String(s));
      }
    }

    for (const link of linksRef.current) {
      const s = typeof link.source === "object" ? link.source : nodesRef.current.find((n) => n.id === link.source);
      const t = typeof link.target === "object" ? link.target : nodesRef.current.find((n) => n.id === link.target);
      if (!s || !t) continue;
      if (activationMode) {
        // Only draw an edge when both ends were actually reached by the traversal -
        // this is meant to show exactly the subgraph the agent would read, not the
        // full link graph with some nodes merely dimmed.
        if (!activationById.has(s.id) || !activationById.has(t.id)) continue;
        ctx.beginPath();
        ctx.moveTo(s.x ?? 0, s.y ?? 0);
        ctx.lineTo(t.x ?? 0, t.y ?? 0);
        ctx.strokeStyle = "rgba(251,146,60,0.6)";
        ctx.lineWidth = 1.6;
        ctx.stroke();
        continue;
      }
      const related = !hovered || s.id === hovered || t.id === hovered;
      ctx.beginPath();
      ctx.moveTo(s.x ?? 0, s.y ?? 0);
      ctx.lineTo(t.x ?? 0, t.y ?? 0);
      if (link.origin === "folder") {
        ctx.strokeStyle = related ? "rgba(167,139,250,0.5)" : "rgba(167,139,250,0.15)";
        ctx.lineWidth = related ? 1 : 0.75;
        ctx.setLineDash([2, 4]);
      } else {
        ctx.strokeStyle = related ? "rgba(148,163,184,0.7)" : "rgba(75,85,99,0.25)";
        ctx.lineWidth = related ? 1.4 : 1;
        ctx.setLineDash(link.resolved ? [] : [4, 3]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const node of nodesRef.current) {
      const activation = activationById.get(node.id);
      const entry = isEntryPoint(node.id);

      if (activationMode) {
        if (!activation) continue; // node not reached by the traversal - not drawn at all
        const r = 8 + activation.activation * 20;
        const color = HOP_COLORS[Math.min(activation.hopDistance, HOP_COLORS.length - 1)] ?? HOP_COLORS[HOP_COLORS.length - 1]!;
        ctx.beginPath();
        ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        if (activation.matchedSeed) {
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = "#fff7ed";
          ctx.stroke();
        }
        if (node.id === selectedId) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = "#ffffff";
          ctx.stroke();
        }
        ctx.fillStyle = "#fff7ed";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(`H${activation.hopDistance} · ${node.title}`, node.x ?? 0, (node.y ?? 0) + r + 12);
        continue;
      }

      const r = nodeRadius(node);
      const isFolder = node.kind === "folder";
      // The entry-point note is the graph's fixed landmark - never dim it, so it stays
      // usable as an orientation point no matter what is hovered.
      const dimmed = !entry && Boolean(hovered) && hovered !== node.id && !neighborIds.has(node.id);
      ctx.beginPath();
      if (isFolder) {
        // Square instead of a circle - a folder is a structural grouping, not a note,
        // and should read as visually distinct at a glance.
        ctx.rect((node.x ?? 0) - r * 0.8, (node.y ?? 0) - r * 0.8, r * 1.6, r * 1.6);
      } else {
        ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, Math.PI * 2);
      }
      ctx.fillStyle = entry ? "#fbbf24" : STATUS_COLOR[node.status] ?? "#60a5fa";
      ctx.globalAlpha = dimmed ? 0.25 : isFolder ? 0.55 : 1;
      ctx.fill();
      if (entry) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "#fde68a";
        ctx.stroke();
      }
      if (node.id === selectedId) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (!dimmed) {
        ctx.fillStyle = entry ? "#fde68a" : isFolder ? "#c4b5fd" : "#e5e7eb";
        ctx.font = entry ? "bold 12px sans-serif" : isFolder ? "italic 10px sans-serif" : "11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(entry ? `★ ${node.title}` : isFolder ? `📁 ${node.title}` : node.title, node.x ?? 0, (node.y ?? 0) + r + 12);
      }
    }
    ctx.restore();
  }

  function toGraphCoords(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const { x, y, k } = transformRef.current;
    return { x: (px - x) / k, y: (py - y) / k };
  }

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const { x, y } = toGraphCoords(e.clientX, e.clientY);
    const hit = nodeAt(nodesRef.current, x, y, activationById);
    if (hit) {
      draggingRef.current = hit;
      hit.fx = hit.x;
      hit.fy = hit.y;
      simRef.current?.alphaTarget(0.3).restart();
    } else {
      panningRef.current = { startX: e.clientX, startY: e.clientY, origin: { ...transformRef.current } };
    }
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (draggingRef.current) {
      const { x, y } = toGraphCoords(e.clientX, e.clientY);
      draggingRef.current.fx = x;
      draggingRef.current.fy = y;
      draw();
      return;
    }
    if (panningRef.current) {
      const dx = e.clientX - panningRef.current.startX;
      const dy = e.clientY - panningRef.current.startY;
      transformRef.current = { ...panningRef.current.origin, x: panningRef.current.origin.x + dx, y: panningRef.current.origin.y + dy };
      draw();
      return;
    }
    const { x, y } = toGraphCoords(e.clientX, e.clientY);
    const hit = nodeAt(nodesRef.current, x, y, activationById);
    const nextHover = hit?.id ?? null;
    if (hoveredRef.current !== nextHover) {
      hoveredRef.current = nextHover;
      draw();
    }
  }

  function handleMouseUp() {
    if (draggingRef.current) {
      draggingRef.current.fx = null;
      draggingRef.current.fy = null;
      simRef.current?.alphaTarget(0);
      draggingRef.current = null;
    }
    panningRef.current = null;
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (panningRef.current) return; // handled as pan, not a click
    const { x, y } = toGraphCoords(e.clientX, e.clientY);
    const hit = nodeAt(nodesRef.current, x, y, activationById);
    setSelectedId(hit?.id ?? null);
  }

  function zoomAround(factor: number, px: number, py: number) {
    const { x, y, k } = transformRef.current;
    const nextK = Math.min(4, Math.max(0.25, k * factor));
    transformRef.current = {
      k: nextK,
      x: px - ((px - x) / k) * nextK,
      y: py - ((py - y) / k) * nextK,
    };
    draw();
  }

  function handleWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    zoomAround(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - rect.left, e.clientY - rect.top);
  }

  // Simple +/- controls next to the wheel/drag gestures, centered on the canvas so
  // clicking them repeatedly zooms in/out on whatever is currently in the middle.
  function handleZoomButton(factor: number) {
    zoomAround(factor, width / 2, height / 2);
  }

  function focusEntryPoint() {
    if (!entryPointNode) return;
    const node = nodesRef.current.find((n) => n.id === entryPointNode.id);
    if (!node) return;
    const k = Math.max(transformRef.current.k, 1);
    transformRef.current = { k, x: width / 2 - (node.x ?? 0) * k, y: height / 2 - (node.y ?? 0) * k };
    setSelectedId(node.id);
    draw();
  }

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, activationResult]);

  function runExpand(seedIds?: string[]) {
    if (seedIds && seedIds.length > 0) {
      expand.mutate({ seedIds });
    } else if (activationQuery.trim()) {
      expand.mutate({ query: activationQuery.trim() });
    }
  }

  function resetActivation() {
    setActivationResult(null);
    setActivationQuery("");
  }

  if (graphQuery.isLoading) {
    return <p className="text-sm text-gray-500">Graph wird geladen...</p>;
  }

  if (nodes.length === 0) {
    return <p className="text-sm text-gray-500">Noch keine Notizen im Wiki - Graph ist leer.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          className="input flex-1 text-xs"
          placeholder="Von hier aus erschliessen (Aktivierungsmodus)..."
          value={activationQuery}
          onChange={(e) => setActivationQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") runExpand();
          }}
        />
        <button className="btn-secondary flex items-center gap-1 px-2" disabled={!activationQuery.trim() || expand.isPending} onClick={() => runExpand()}>
          <Sparkles className="w-3.5 h-3.5" />
          Erschliessen
        </button>
        {activationResult && (
          <button className="btn-secondary px-2" title="Aktivierungsmodus verlassen" onClick={resetActivation}>
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {activationResult && (
        <p className="text-xs text-amber-300">
          Aktivierungsmodus: {activationResult.length} Knoten erreicht (Farbe = Hop-Distanz, Groesse = Aktivierung). Zeigt exakt, was der Agent
          über <code>wiki action=expand</code> lesen würde.
        </p>
      )}
      <div className="flex gap-3">
      <div ref={containerRef} className="relative flex-1 min-w-0 border border-gray-800 rounded-lg overflow-hidden bg-gray-950">
        <canvas
          ref={canvasRef}
          style={{ width: `${width}px`, height: `${height}px`, cursor: draggingRef.current ? "grabbing" : "grab" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={handleClick}
          onWheel={handleWheel}
        />
        <div className="absolute top-2 right-2 flex flex-col gap-1">
          <button
            className="w-7 h-7 flex items-center justify-center rounded bg-gray-900/90 border border-gray-700 text-gray-200 hover:bg-gray-800"
            title="Vergroessern"
            onClick={() => handleZoomButton(1.2)}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            className="w-7 h-7 flex items-center justify-center rounded bg-gray-900/90 border border-gray-700 text-gray-200 hover:bg-gray-800"
            title="Verkleinern"
            onClick={() => handleZoomButton(0.8)}
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          {entryPointNode && (
            <button
              className="w-7 h-7 flex items-center justify-center rounded bg-amber-500/90 border border-amber-300 text-gray-900 hover:bg-amber-400"
              title="Zum Einstiegspunkt (llm-wiki Index)"
              onClick={focusEntryPoint}
            >
              <Compass className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {selectedNode && (
        <div className="w-72 shrink-0 border border-gray-800 rounded-lg p-3 space-y-3 bg-gray-900">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-semibold text-white">{selectedNode.title}</p>
              <p className="text-xs text-gray-500">{selectedNode.id}</p>
            </div>
            <button className="text-gray-400 hover:text-white" onClick={() => setSelectedId(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">status={selectedNode.status}</span>
            {selectedNode.tags.map((tag) => (
              <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">
                #{tag}
              </span>
            ))}
          </div>

          <button
            className="btn-secondary w-full flex items-center justify-center gap-1 text-xs"
            disabled={expand.isPending}
            onClick={() => runExpand([selectedNode.id])}
          >
            <Sparkles className="w-3.5 h-3.5" />
            Von hier erschliessen
          </button>

          <div>
            <p className="text-xs text-gray-400 mb-1">Ausgehend ({outgoing.length})</p>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {outgoing.map((edge) => (
                <div key={edge.id} className="flex items-center justify-between text-xs bg-gray-950 border border-gray-800 rounded px-2 py-1">
                  <span className={edge.resolved ? "text-gray-300" : "text-gray-500 italic"}>
                    {edge.origin === "folder" ? `📁 ${edge.target}` : edge.target}
                  </span>
                  {typeof edge.id === "number" && (
                    <button className="text-red-400 hover:text-red-300" onClick={() => deleteLink.mutate(edge.id as number)} disabled={deleteLink.isPending}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {outgoing.length === 0 && <p className="text-xs text-gray-600">Keine.</p>}
            </div>
          </div>

          <div>
            <p className="text-xs text-gray-400 mb-1">Eingehend ({incoming.length})</p>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {incoming.map((edge) => (
                <div key={edge.id} className="flex items-center justify-between text-xs bg-gray-950 border border-gray-800 rounded px-2 py-1">
                  <span className="text-gray-300">{edge.origin === "folder" ? `📁 ${edge.source}` : edge.source}</span>
                  {typeof edge.id === "number" && (
                    <button className="text-red-400 hover:text-red-300" onClick={() => deleteLink.mutate(edge.id as number)} disabled={deleteLink.isPending}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {incoming.length === 0 && <p className="text-xs text-gray-600">Keine.</p>}
            </div>
          </div>

          {selectedNode.kind !== "folder" && (
            <div className="space-y-1">
              <p className="text-xs text-gray-400">Verbindung hinzufugen</p>
              <div className="flex gap-1">
                <select className="input flex-1 text-xs" value={addTarget} onChange={(e) => setAddTarget(e.target.value)}>
                  <option value="">Ziel waehlen...</option>
                  {otherNodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.title}
                    </option>
                  ))}
                </select>
                <button
                  className="btn-secondary px-2"
                  disabled={!addTarget || createLink.isPending}
                  onClick={() => selectedId && addTarget && createLink.mutate({ sourceFile: selectedId, targetFile: addTarget })}
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
