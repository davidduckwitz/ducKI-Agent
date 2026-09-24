import { describe, expect, it } from "vitest";
import { toPlanEventPayload } from "../src/planner/plan-tool";
import type { Plan } from "../src/planner/planner";

describe("toPlanEventPayload", () => {
  it("preserves the complete executable step contract", () => {
    const plan: Plan = {
      goal: "Ship safely",
      estimatedComplexity: "high",
      totalSteps: 1,
      steps: [{
        id: "step_1",
        title: "Implement feature",
        description: "Change the implementation",
        status: "running",
        toolsNeeded: ["filesystem", "shell"],
        dependsOn: ["step_0"],
        canParallelizeWith: ["step_2"],
        expectedFiles: ["src/feature.ts"],
        acceptanceCriteria: ["The feature behaves as specified"],
        verificationCommands: ["npm test"],
        estimatedDuration: 15,
        priority: "critical",
        riskLevel: "high",
        result: "work in progress",
      }],
    };

    const payload = toPlanEventPayload(plan, "# Plan");

    expect(payload.steps[0]).toEqual(plan.steps[0]);
    expect(payload.steps[0]).not.toBe(plan.steps[0]);
    expect(payload.steps[0]).not.toHaveProperty("duration");
    expect(payload.steps[0]).not.toHaveProperty("parallelizable");
  });
});
