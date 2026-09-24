import { describe, it, expect } from "vitest";
import { CodingAgent } from "../src/coding/coding-agent";
import type { Plan } from "../src/planner/planner";

/**
 * Regression coverage: the Planner computes dependsOn/riskLevel/toolsNeeded for every step
 * (PlanStep carries all of it), but buildInitialPrompt used to render only title+description -
 * the rest was computed and then silently discarded before it ever reached the executing model.
 */
function buildCodingAgent(): CodingAgent {
  const provider = {
    generate: async () => ({ content: "" }),
    generateStream: async () => ({ content: "" }),
    supportsStreaming: () => false,
  } as any;
  const db = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
  } as any;
  return new CodingAgent(provider, db, undefined, {});
}

describe("CodingAgent plan step metadata reaches the prompt", () => {
  it("includes dependencies, risk, tools and verification contracts when present", () => {
    const agent = buildCodingAgent();
    const plan: Plan = {
      goal: "do the thing",
      estimatedComplexity: "medium",
      steps: [
        { id: "1", title: "Read config", description: "locate settings", status: "pending" },
        {
          id: "2",
          title: "Update schema",
          description: "add the column",
          status: "pending",
          dependsOn: ["1"],
          riskLevel: "high",
          toolsNeeded: ["filesystem", "shell"],
          expectedFiles: ["src/schema.ts"],
          acceptanceCriteria: ["Migration remains backwards compatible"],
          verificationCommands: ["npm test -- schema"],
        },
      ],
    };
    const prompt = (agent as any).buildInitialPrompt("do the thing", "npm test", plan);

    expect(prompt).toContain("2. Update schema - add the column [depends on: 1 · risk: high · tools: filesystem, shell");
    expect(prompt).toContain("files: src/schema.ts");
    expect(prompt).toContain("done when: Migration remains backwards compatible");
    expect(prompt).toContain("verify: npm test -- schema");
  });

  it("omits the metadata bracket entirely for a plain step", () => {
    const agent = buildCodingAgent();
    const plan: Plan = {
      goal: "do the thing",
      estimatedComplexity: "low",
      steps: [{ id: "1", title: "Read config", status: "pending" }],
    };
    const prompt = (agent as any).buildInitialPrompt("do the thing", "npm test", plan);

    expect(prompt).toContain("1. Read config");
    expect(prompt).not.toContain("[depends on");
    expect(prompt).not.toContain("[risk");
  });

  it("does not surface low risk - only medium/high are worth flagging", () => {
    const agent = buildCodingAgent();
    const plan: Plan = {
      goal: "do the thing",
      estimatedComplexity: "low",
      steps: [{ id: "1", title: "Read config", status: "pending", riskLevel: "low" }],
    };
    const prompt = (agent as any).buildInitialPrompt("do the thing", "npm test", plan);

    expect(prompt).not.toContain("risk: low");
  });
});
