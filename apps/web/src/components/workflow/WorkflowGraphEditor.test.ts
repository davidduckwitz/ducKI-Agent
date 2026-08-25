import { describe, expect, it } from "vitest";
import { workflowDisplayEdges } from "./WorkflowGraphEditor";

describe("workflowDisplayEdges", () => {
  it("renders legacy dependsOn-only connections and de-duplicates explicit edges", () => {
    const workflow = {
      id: "wf",
      name: "test",
      goal: "",
      status: "draft" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [
        { id: "a", title: "A", role: "manager" as const, prompt: "", status: "pending" as const, dependsOn: [] },
        { id: "b", title: "B", role: "manager" as const, prompt: "", status: "pending" as const, dependsOn: ["a"] },
        { id: "c", title: "C", role: "manager" as const, prompt: "", status: "pending" as const, dependsOn: ["b"] },
      ],
      edges: [{ id: "ab", source: "a", target: "b" }],
    };
    expect(workflowDisplayEdges(workflow)).toEqual([
      { id: "ab", source: "a", target: "b" },
      { id: "inferred_b_c", source: "b", target: "c" },
    ]);
  });
});
