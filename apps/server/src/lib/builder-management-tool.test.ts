import { describe, expect, it } from "vitest";
import type { DatabaseService } from "@ducki/database";
import { createBuilderManagementTool } from "./builder-management-tool.js";

function dbWithMode(mode: string): DatabaseService {
  return { getSetting: async (key: string) => key === "BUILDER_AGENT_MODE" ? mode : null } as DatabaseService;
}

describe("builder management tool", () => {
  it("reports the active autonomous policy and precise builder contracts", async () => {
    const result = await createBuilderManagementTool(dbWithMode("suggest")).execute({ action: "capabilities" });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ mode: "suggest", plugin: { createdDisabled: true }, skill: { asynchronous: false } });
  });

  it("blocks an autonomous create call unless autonomous mode is enabled", async () => {
    const result = await createBuilderManagementTool(dbWithMode("manual")).execute({
      action: "create",
      kind: "skill",
      trigger: "autonomous",
      spec: { name: "test" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Autonomous builder use is disabled/);
  });
});
