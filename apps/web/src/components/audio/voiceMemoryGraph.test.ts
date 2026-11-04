import { describe, expect, it } from "vitest";
import { buildVoiceMemoryGraph, relaxVoiceMemoryLayout, type WikiMemoryNode } from "./voiceMemoryGraph";

const node = (id: string): WikiMemoryNode => ({
  id,
  title: id.replace(".md", ""),
  status: "approved",
  tags: [],
  degree: 1,
});

describe("buildVoiceMemoryGraph", () => {
  it("keeps the root index fixed in the center and places linked notes around it", () => {
    const graph = buildVoiceMemoryGraph({
      nodes: [node("topic.md"), node("index.md"), node("inbound.md")],
      edges: [
        { id: 1, source: "index.md", target: "topic.md", resolved: true },
        { id: 2, source: "inbound.md", target: "index.md", resolved: true },
      ],
    });

    expect(graph?.nodes[0]).toMatchObject({ id: "index.md", x: 0, y: 0, z: 0, hop: 0 });
    expect(graph?.nodes.slice(1).every((entry) => entry.hop === 1)).toBe(true);
    expect(graph?.edges).toHaveLength(2);
    expect(graph?.edges.every((edge) => edge.direct)).toBe(true);
  });

  it("uses the first nested index when there is no root index", () => {
    const graph = buildVoiceMemoryGraph({
      nodes: [node("memory/index.md"), node("memory/topic.md")],
      edges: [{ id: 1, source: "memory/index.md", target: "memory/topic.md", resolved: true }],
    });
    expect(graph?.nodes[0]?.id).toBe("memory/index.md");
  });

  it("ignores unresolved visual links and requires an index", () => {
    expect(buildVoiceMemoryGraph({ nodes: [node("topic.md")], edges: [] })).toBeNull();
    const graph = buildVoiceMemoryGraph({
      nodes: [node("index.md"), node("missing.md")],
      edges: [{ id: 1, source: "index.md", target: "missing.md", resolved: false }],
    });
    expect(graph?.edges).toEqual([]);
  });
});

describe("relaxVoiceMemoryLayout", () => {
  it("keeps the root fixed, lists incident edges and moves notes apart", () => {
    const ids = ["index.md", "a.md", "b.md", "c.md", "d.md"];
    const graph = buildVoiceMemoryGraph({
      nodes: ids.map(node),
      edges: ids.slice(1).map((id, i) => ({ id: i, source: "index.md", target: id, resolved: true })),
    })!;
    expect(graph.incident[0]).toHaveLength(4);
    expect(graph.incident[1]).toHaveLength(1);
    const relaxed = relaxVoiceMemoryLayout(graph);
    expect(relaxed.nodes[0]).toMatchObject({ x: 0, y: 0, z: 0 });
    for (const entry of relaxed.nodes) expect(Number.isFinite(entry.x + entry.y + entry.z)).toBe(true);
    const minDistance = Math.min(...relaxed.nodes.slice(1).flatMap((a, i) => relaxed.nodes.slice(i + 2)
      .map((b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z))));
    expect(minDistance).toBeGreaterThan(0.2);
  });
});
