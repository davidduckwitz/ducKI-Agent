import { describe, expect, it } from "vitest";
import { mergeCodingPlanSnapshots, normalizeCodingPlanStepStatus } from "./codingPlan";

describe("coding plan normalization", () => {
  it("normalizes terminal controller statuses for the Plan tab", () => {
    expect(normalizeCodingPlanStepStatus("completed")).toBe("done");
    expect(normalizeCodingPlanStepStatus("running")).toBe("in_progress");
    expect(normalizeCodingPlanStepStatus("blocked")).toBe("failed");
    expect(normalizeCodingPlanStepStatus("unknown")).toBe("unknown");
  });

  it("keeps live status/order while restoring contracts omitted by legacy plan events", () => {
    const persisted = {
      id: 7,
      goal: "Build it",
      steps: [
        {
          id: "step_1",
          title: "Implement endpoint",
          description: "Persisted description",
          status: "pending",
          expectedFiles: ["src/api.ts"],
          acceptanceCriteria: ["GET /health returns 200"],
          verificationCommands: ["npm test"],
          dependsOn: ["step_0"],
        },
      ],
    };
    const live = {
      id: 7,
      goal: "Build it",
      steps: [
        { id: "step_1", title: "Implement endpoint", description: "Live description", status: "completed" },
      ],
    };

    const merged = mergeCodingPlanSnapshots(live, persisted)!;
    expect(merged.steps?.[0]).toMatchObject({
      description: "Live description",
      status: "completed",
      expectedFiles: ["src/api.ts"],
      acceptanceCriteria: ["GET /health returns 200"],
      verificationCommands: ["npm test"],
      dependsOn: ["step_0"],
    });
  });

  it("selects the genuinely newer plan instead of merging different versions", () => {
    const oldPlan = { id: 4, goal: "Old", steps: [{ title: "Old step", description: "" }] };
    const newPlan = { id: 5, goal: "New", steps: [{ title: "New step", description: "" }] };
    expect(mergeCodingPlanSnapshots(oldPlan, newPlan)?.id).toBe(5);
  });
});
