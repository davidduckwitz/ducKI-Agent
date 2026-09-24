import { describe, expect, it } from "vitest";
import type { PlanStep } from "@ducki/agent";
import { restorePlanStepContracts } from "./plan-step-contracts";

describe("restorePlanStepContracts", () => {
  it("restores contracts missing from a legacy live event and keeps its current status", () => {
    const persisted: PlanStep[] = [{
      id: "step_1",
      title: "Implement feature",
      description: "Persisted description",
      status: "pending",
      expectedFiles: ["src/feature.ts"],
      acceptanceCriteria: ["Works end-to-end"],
      verificationCommands: ["npm test"],
      dependsOn: ["step_0"],
    }];

    const [merged] = restorePlanStepContracts(
      [{ id: "step_1", title: "Implement feature", description: "Live description", status: "running" }],
      persisted
    );

    expect(merged).toMatchObject({
      description: "Live description",
      status: "running",
      expectedFiles: ["src/feature.ts"],
      acceptanceCriteria: ["Works end-to-end"],
      verificationCommands: ["npm test"],
      dependsOn: ["step_0"],
    });
  });

  it("falls back to title matching when a legacy event has no stable id", () => {
    const persisted: PlanStep[] = [{
      id: "step_1",
      title: "Implement feature",
      description: "Do it",
      status: "pending",
      expectedFiles: ["src/feature.ts"],
    }];

    expect(restorePlanStepContracts([{ title: " implement FEATURE " }], persisted)[0]?.expectedFiles)
      .toEqual(["src/feature.ts"]);
  });
});
