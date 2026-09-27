import { describe, expect, it } from "vitest";
import { buildVoiceMemoryGraph, type WikiMemoryNode } from "./voiceMemoryGraph";

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
