export interface WikiMemoryNode {
  id: string;
  title: string;
  status: string;
  tags: string[];
  degree: number;
  kind?: "note" | "folder";
  preview?: string;
}

export interface WikiMemoryEdge {
  id: number | string;
  source: string;
  target: string;
  resolved: boolean;
}

export interface VoiceMemoryNode extends WikiMemoryNode {
  x: number;
  y: number;
  z: number;
  hop: number;
  phase: number;
}

export interface VoiceMemoryEdge {
  source: number;
  target: number;
  direct: boolean;
}

export interface VoiceMemoryGraph {
  nodes: VoiceMemoryNode[];
  edges: VoiceMemoryEdge[];
  rootIndex: number;
  /** Per node: indices into `edges` touching it - the paths a synapse discharge can take. */
  incident: number[][];
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function isRootIndex(id: string): boolean {
  const normalized = id.toLowerCase().replace(/\\/g, "/");
  return normalized === "index.md";
}

function isNestedIndex(id: string): boolean {
  return id.toLowerCase().replace(/\\/g, "/").endsWith("/index.md");
}

/**
 * Converts the editable 2D wiki graph into a stable, read-only 3D memory model.
 * Incoming and outgoing links both count as proximity to the central index: link
 * direction is useful in the editor, but should not split the visual memory orbit.
 */
export function buildVoiceMemoryGraph(
  data?: { nodes: WikiMemoryNode[]; edges: WikiMemoryEdge[] } | null,
): VoiceMemoryGraph | null {
  if (!data?.nodes.length) return null;

  const root = data.nodes.find((node) => node.kind !== "folder" && isRootIndex(node.id))
    ?? data.nodes.find((node) => node.kind !== "folder" && isNestedIndex(node.id));
  if (!root) return null;

  const sourceById = new Map(data.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, Set<string>>();
  for (const node of data.nodes) adjacency.set(node.id, new Set());
  for (const edge of data.edges) {
    if (!edge.resolved || !sourceById.has(edge.source) || !sourceById.has(edge.target)) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  const hops = new Map<string, number>([[root.id, 0]]);
  const queue = [root.id];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    const nextHop = (hops.get(current) ?? 0) + 1;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (hops.has(neighbor)) continue;
      hops.set(neighbor, nextHop);
      queue.push(neighbor);
    }
  }

  const ordered = [...data.nodes].sort((a, b) => {
    if (a.id === root.id) return -1;
    if (b.id === root.id) return 1;
    const hopDifference = (hops.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (hops.get(b.id) ?? Number.MAX_SAFE_INTEGER);
    return hopDifference || a.id.localeCompare(b.id);
  });
  const maxConnectedHop = Math.max(1, ...hops.values());
  const orbiting = ordered.length - 1;
  const nodes: VoiceMemoryNode[] = ordered.map((node, index) => {
    if (node.id === root.id) return { ...node, x: 0, y: 0, z: 0, hop: 0, phase: 0 };
    const orbitIndex = index - 1;
    const hop = hops.get(node.id) ?? maxConnectedHop + 1;
    const normalizedY = orbiting <= 1 ? 0 : 1 - (orbitIndex / (orbiting - 1)) * 2;
    const horizontalRadius = Math.sqrt(Math.max(0, 1 - normalizedY * normalizedY));
    const angle = orbitIndex * GOLDEN_ANGLE;
    // Direct index connections form the inner memory shell. More distant and
    // disconnected notes remain visible on progressively wider shells.
    const shell = Math.min(1.14, 0.68 + Math.max(0, hop - 1) * 0.12);
    return {
      ...node,
      x: Math.cos(angle) * horizontalRadius * shell,
      y: normalizedY * shell * 0.72,
      z: Math.sin(angle) * horizontalRadius * shell,
      hop,
      phase: angle,
    };
  });

  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const edges: VoiceMemoryEdge[] = [];
  for (const edge of data.edges) {
    if (!edge.resolved) continue;
    const source = indexById.get(edge.source);
    const target = indexById.get(edge.target);
    if (source === undefined || target === undefined) continue;
    edges.push({ source, target, direct: source === 0 || target === 0 });
  }

  const incident = nodes.map((): number[] => []);
  edges.forEach((edge, edgeIndex) => {
    incident[edge.source]!.push(edgeIndex);
    if (edge.target !== edge.source) incident[edge.target]!.push(edgeIndex);
  });

  return { nodes, edges, rootIndex: 0, incident };
}

/**
 * Relaxes the golden-angle shells into an organic 3D network: linked notes pull
 * together, all notes push apart, and each note is softly held on its hop shell so
 * the "distance from index.md" reading survives. The root never moves. The
 * iteration count shrinks with n^2 so large wikis stay well under ~100 ms.
 */
export function relaxVoiceMemoryLayout(graph: VoiceMemoryGraph): VoiceMemoryGraph {
  const count = graph.nodes.length;
  if (count < 3) return graph;
  const x = Float64Array.from(graph.nodes, (node) => node.x);
  const y = Float64Array.from(graph.nodes, (node) => node.y);
  const z = Float64Array.from(graph.nodes, (node) => node.z);
  const shell = Float64Array.from(graph.nodes, (node) => Math.hypot(node.x, node.y / 0.72, node.z));
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  const iterations = Math.max(12, Math.min(140, Math.floor(4e7 / (count * count))));
  const repulsion = 0.012 / Math.sqrt(count);
  for (let step = 0; step < iterations; step += 1) {
    const cooling = 1 - step / iterations;
    fx.fill(0); fy.fill(0); fz.fill(0);
    for (let a = 1; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        const dx = x[a]! - x[b]!, dy = y[a]! - y[b]!, dz = z[a]! - z[b]!;
        const distanceSq = Math.max(1e-4, dx * dx + dy * dy + dz * dz);
        const push = repulsion / distanceSq;
        fx[a]! += dx * push; fy[a]! += dy * push; fz[a]! += dz * push;
        fx[b]! -= dx * push; fy[b]! -= dy * push; fz[b]! -= dz * push;
      }
    }
    for (const edge of graph.edges) {
      const dx = x[edge.target]! - x[edge.source]!, dy = y[edge.target]! - y[edge.source]!, dz = z[edge.target]! - z[edge.source]!;
      const pull = edge.direct ? 0.02 : 0.05;
      fx[edge.source]! += dx * pull; fy[edge.source]! += dy * pull; fz[edge.source]! += dz * pull;
      fx[edge.target]! -= dx * pull; fy[edge.target]! -= dy * pull; fz[edge.target]! -= dz * pull;
    }
    for (let i = 1; i < count; i += 1) {
      const radius = Math.max(1e-3, Math.hypot(x[i]!, y[i]! / 0.72, z[i]!));
      const toShell = (shell[i]! - radius) * 0.18;
      fx[i]! += (x[i]! / radius) * toShell; fy[i]! += (y[i]! / radius) * toShell; fz[i]! += (z[i]! / radius) * toShell;
      const limit = 0.06 * cooling + 0.004;
      const length = Math.hypot(fx[i]!, fy[i]!, fz[i]!);
      const scale = length > limit ? limit / length : 1;
      x[i]! += fx[i]! * scale; y[i]! += fy[i]! * scale; z[i]! += fz[i]! * scale;
    }
  }
  return {
    ...graph,
    nodes: graph.nodes.map((node, i) => (i === graph.rootIndex ? node : { ...node, x: x[i]!, y: y[i]!, z: z[i]! })),
  };
}
