/**
 * Multi-source spreading activation over the wiki link graph, used by both the
 * `wiki` agent tool (`action=expand`) and the graph UI's activation mode - one
 * algorithm, so what the agent reads and what the graph draws are the same thing.
 *
 * This is Dijkstra's algorithm with a multiplicative edge "weight": activation
 * decays by a fixed factor per hop, so the highest-activation node discovered so
 * far is always the true maximum reachable from any seed (decay < 1 means
 * activation only ever shrinks along a path, exactly the non-negative-weight
 * precondition Dijkstra needs). Popping greedily by activation therefore gives a
 * provably correct "max over all paths" aggregation, not an approximation - the
 * stability property this was built for.
 */

export interface ActivationGraphNode {
  id: string;
  title: string;
  status: string;
  tags: string[];
}

export interface ActivationGraphEdge {
  source: string;
  target: string;
}

export interface ActivationSeed {
  id: string;
  activation: number;
}

export interface ActivationResultNode {
  id: string;
  title: string;
  status: string;
  tags: string[];
  hopDistance: number;
  activation: number;
  matchedSeed: boolean;
}

export interface ActivationOptions {
  maxHops?: number;
  maxNodes?: number;
  decay?: number;
}

// Hard ceilings - always enforced regardless of what a caller (agent or UI) asks
// for, so a request can never blow past a bounded amount of work or output.
export const ACTIVATION_MAX_HOPS_CAP = 3;
export const ACTIVATION_MAX_NODES_CAP = 25;
const DEFAULT_MAX_HOPS = 2;
const DEFAULT_MAX_NODES = 12;
const DEFAULT_DECAY = 0.55;

interface Tentative {
  activation: number;
  hop: number;
  matchedSeed: boolean;
}

export function spreadActivation(
  nodes: ActivationGraphNode[],
  edges: ActivationGraphEdge[],
  seeds: ActivationSeed[],
  options: ActivationOptions = {}
): ActivationResultNode[] {
  const maxHops = Math.max(1, Math.min(options.maxHops ?? DEFAULT_MAX_HOPS, ACTIVATION_MAX_HOPS_CAP));
  const maxNodes = Math.max(1, Math.min(options.maxNodes ?? DEFAULT_MAX_NODES, ACTIVATION_MAX_NODES_CAP));
  const decay = Math.min(0.95, Math.max(0.05, options.decay ?? DEFAULT_DECAY));

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) continue;
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }

  // Even the seed set itself must respect the node budget - a query matching 50
  // notes should not blow past maxNodes before any spreading even happens.
  const validSeeds = seeds
    .filter((s) => nodesById.has(s.id) && s.activation > 0)
    .sort((a, b) => b.activation - a.activation || a.id.localeCompare(b.id))
    .slice(0, maxNodes);

  const best = new Map<string, Tentative>();
  const finalized = new Map<string, Tentative>();

  for (const seed of validSeeds) {
    const existing = best.get(seed.id);
    if (!existing || seed.activation > existing.activation) {
      best.set(seed.id, { activation: seed.activation, hop: 0, matchedSeed: true });
    }
  }

  while (finalized.size < maxNodes) {
    let bestId: string | undefined;
    let bestEntry: Tentative | undefined;
    for (const [id, entry] of best) {
      if (finalized.has(id)) continue;
      const better =
        !bestEntry ||
        entry.activation > bestEntry.activation ||
        (entry.activation === bestEntry.activation && (bestId === undefined || id < bestId));
      if (better) {
        bestId = id;
        bestEntry = entry;
      }
    }
    if (!bestId || !bestEntry) break;

    finalized.set(bestId, bestEntry);

    if (bestEntry.hop < maxHops) {
      const neighbors = adjacency.get(bestId);
      if (neighbors) {
        const nextActivation = bestEntry.activation * decay;
        for (const neighborId of Array.from(neighbors).sort()) {
          if (finalized.has(neighborId)) continue;
          const existing = best.get(neighborId);
          if (!existing || nextActivation > existing.activation) {
            best.set(neighborId, { activation: nextActivation, hop: bestEntry.hop + 1, matchedSeed: false });
          }
        }
      }
    }
  }

  return Array.from(finalized.entries())
    .map(([id, entry]) => {
      const node = nodesById.get(id);
      if (!node) return undefined;
      return {
        id: node.id,
        title: node.title,
        status: node.status,
        tags: node.tags,
        hopDistance: entry.hop,
        activation: entry.activation,
        matchedSeed: entry.matchedSeed,
      };
    })
    .filter((n): n is ActivationResultNode => Boolean(n))
    .sort((a, b) => b.activation - a.activation || a.id.localeCompare(b.id));
}
