import { describe, expect, it } from "vitest";
import {
  ACTIVATION_MAX_NODES_CAP,
  spreadActivation,
  type ActivationGraphEdge,
  type ActivationGraphNode,
} from "./spreading-activation.js";

function node(id: string): ActivationGraphNode {
  return { id, title: id, status: "approved", tags: [] };
}

describe("spreadActivation", () => {
  it("respects the hop limit - nothing beyond maxHops is returned", () => {
    // chain: a - b - c - d - e (a is the seed)
    const nodes = ["a", "b", "c", "d", "e"].map(node);
    const edges: ActivationGraphEdge[] = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "d" },
      { source: "d", target: "e" },
    ];
    const result = spreadActivation(nodes, edges, [{ id: "a", activation: 1 }], { maxHops: 2, maxNodes: 25 });
    const ids = result.map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
    expect(result.every((r) => r.hopDistance <= 2)).toBe(true);
  });

  it("respects the node limit even when the graph is a dense hub", () => {
    const hubNeighbors = Array.from({ length: 200 }, (_, i) => `leaf${i}`);
    const nodes = [node("hub"), ...hubNeighbors.map(node)];
    const edges: ActivationGraphEdge[] = hubNeighbors.map((id) => ({ source: "hub", target: id }));

    const start = Date.now();
    const result = spreadActivation(nodes, edges, [{ id: "hub", activation: 1 }], { maxHops: 3, maxNodes: 10 });
    const elapsedMs = Date.now() - start;

    expect(result.length).toBeLessThanOrEqual(10);
    expect(result.length).toBeLessThanOrEqual(ACTIVATION_MAX_NODES_CAP);
    expect(elapsedMs).toBeLessThan(200);
  });

  it("never exceeds the hard node cap even if a caller asks for more", () => {
    const hubNeighbors = Array.from({ length: 200 }, (_, i) => `leaf${i}`);
    const nodes = [node("hub"), ...hubNeighbors.map(node)];
    const edges: ActivationGraphEdge[] = hubNeighbors.map((id) => ({ source: "hub", target: id }));
    const result = spreadActivation(nodes, edges, [{ id: "hub", activation: 1 }], { maxHops: 3, maxNodes: 10000 });
    expect(result.length).toBeLessThanOrEqual(ACTIVATION_MAX_NODES_CAP);
  });

  it("does not infinite-loop or duplicate nodes on a cycle", () => {
    // a - b - c - a (triangle)
    const nodes = ["a", "b", "c"].map(node);
    const edges: ActivationGraphEdge[] = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "a" },
    ];
    const result = spreadActivation(nodes, edges, [{ id: "a", activation: 1 }], { maxHops: 3, maxNodes: 25 });
    const ids = result.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(["a", "b", "c"]);
  });

  it("activation decays monotonically with hop distance along a chain", () => {
    const nodes = ["a", "b", "c"].map(node);
    const edges: ActivationGraphEdge[] = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ];
    const result = spreadActivation(nodes, edges, [{ id: "a", activation: 1 }], { maxHops: 2, maxNodes: 25 });
    const byId = new Map(result.map((r) => [r.id, r]));
    expect(byId.get("a")!.activation).toBeGreaterThan(byId.get("b")!.activation);
    expect(byId.get("b")!.activation).toBeGreaterThan(byId.get("c")!.activation);
  });

  it("uses max activation across multiple paths, not the sum (hub nodes are not over-weighted)", () => {
    // a and b are two independent seeds, both connected to hub c. If activation summed,
    // c would end up with more activation than either seed - it must not exceed the max
    // of the two paths landing on it.
    const nodes = ["a", "b", "c"].map(node);
    const edges: ActivationGraphEdge[] = [
      { source: "a", target: "c" },
      { source: "b", target: "c" },
    ];
    const result = spreadActivation(
      nodes,
      edges,
      [
        { id: "a", activation: 1 },
        { id: "b", activation: 0.9 },
      ],
      { maxHops: 1, maxNodes: 25 }
    );
    const c = result.find((r) => r.id === "c")!;
    expect(c.activation).toBeLessThanOrEqual(1 * 0.55);
    expect(c.activation).toBeCloseTo(1 * 0.55, 10);
  });

  it("is deterministic - repeated calls on the same graph and seed produce identical output", () => {
    const nodes = ["a", "b", "c", "d"].map(node);
    const edges: ActivationGraphEdge[] = [
      { source: "a", target: "b" },
      { source: "a", target: "c" },
      { source: "b", target: "d" },
      { source: "c", target: "d" },
    ];
    const seeds = [{ id: "a", activation: 1 }];
    const first = spreadActivation(nodes, edges, seeds, { maxHops: 2, maxNodes: 10 });
    const second = spreadActivation(nodes, edges, seeds, { maxHops: 2, maxNodes: 10 });
    expect(second).toEqual(first);
  });

  it("caps the seed set itself against maxNodes before any spreading", () => {
    const nodes = Array.from({ length: 30 }, (_, i) => node(`n${i}`));
    const seeds = nodes.map((n, i) => ({ id: n.id, activation: 30 - i }));
    const result = spreadActivation(nodes, [], seeds, { maxHops: 2, maxNodes: 5 });
    expect(result.length).toBe(5);
    expect(result.map((r) => r.id)).toEqual(["n0", "n1", "n2", "n3", "n4"]);
  });

  it("ignores edges pointing at unknown nodes without throwing", () => {
    const nodes = [node("a"), node("b")];
    const edges: ActivationGraphEdge[] = [{ source: "a", target: "ghost" }];
    expect(() => spreadActivation(nodes, edges, [{ id: "a", activation: 1 }], {})).not.toThrow();
  });
});
