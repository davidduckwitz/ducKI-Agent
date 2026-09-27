export interface WikiMemoryNode {
  id: string;
  title: string;
  status: string;
  tags: string[];
  degree: number;
  kind?: "note" | "folder";
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

  return { nodes, edges, rootIndex: 0 };
}
