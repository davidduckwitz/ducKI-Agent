import { describe, expect, it } from "vitest";
import { buildVoiceMemoryGraph, type WikiMemoryNode } from "../voiceMemoryGraph";
import { pickLabelNodes } from "./labelOverlay";
import type { ProjectedNode } from "./memoryBackdrop";

const node = (id: string, degree = 1): WikiMemoryNode => ({ id, title: id, status: "approved", tags: [], degree });
const graph = buildVoiceMemoryGraph({
  nodes: [node("index.md", 3), node("a.md", 4), node("b.md"), node("c.md"), node("back.md")],
  edges: ["a.md", "b.md", "c.md", "back.md"].map((target, i) => ({ id: i, source: "index.md", target, resolved: true })),
})!;
const at = (index: number, x: number, y: number, depth = -0.5): ProjectedNode => ({ index, x, y, depth });
const base = { width: 1000, height: 800, avoid: null };

describe("pickLabelNodes", () => {
  it("labels nothing in mode none", () => {
    expect(pickLabelNodes([at(0, 500, 400)], graph, { ...base, mode: "none" })).toEqual([]);
  });

  it("keeps the root, skips back-facing, off-screen and orb-covered nodes", () => {
    const projected = [at(0, 100, 100), at(1, 400, 300), at(2, 700, 600, 0.6), at(3, -5, 300), at(4, 500, 400)];
    const picked = pickLabelNodes(projected, graph, { ...base, mode: "titles", avoid: { x: 450, y: 350, width: 100, height: 100 } });
    expect(picked).toEqual([0, 1]);
  });

  it("spreads labels apart", () => {
    const picked = pickLabelNodes([at(1, 400, 300), at(2, 420, 305), at(3, 800, 300)], graph, { ...base, mode: "titles" });
    expect(picked).toContain(1);
    expect(picked).toContain(3);
    expect(picked).not.toContain(2);
  });
});
