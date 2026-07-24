import { describe, expect, it } from "vitest";
import { createAgentForParserTests } from "./utils/agent-test-harness.ts";
import type { AgentRuntimeControls } from "../src/config/interfaces_types.ts";

type PreflightResult = { ok: true; input: Record<string, unknown> } | { ok: false; error: string };

type PrivateGatingMethods = {
  preflightToolInput: (
    toolName: string,
    input: Record<string, unknown>,
    controls: AgentRuntimeControls
  ) => Promise<PreflightResult>;
};

function asPrivate(agent: ReturnType<typeof createAgentForParserTests>): PrivateGatingMethods {
  return agent as unknown as PrivateGatingMethods;
}

function buildControls(enabledOptionalTools: string[]): AgentRuntimeControls {
  return {
    maxIterations: 50,
    timeoutMs: 600_000,
    shellToolTimeoutMs: 120_000,
    httpToolTimeoutMs: 60_000,
    browserToolTimeoutMs: 120_000,
    gitToolTimeoutMs: 120_000,
    enableAutoMemory: false,
    enableReflection: false,
    reflectionMaxRetries: 0,
    reflectionStoreMemory: false,
    reflectionMetaReview: false,
    reasonerUseToolMinConfidence: 0.65,
    maxConsecutiveToolFailures: 3,
    maxRepeatedToolCall: 3,
    selfRepairEnabled: false,
    selfRepairMaxAttempts: 0,
    enableAutoSkillSelection: false,
    autoSkillScoreThreshold: 0.78,
    autoSkillMarginThreshold: 0.2,
    autoSkillMinInputLength: 20,
    autoSkillMinOverlap: 2,
    skillBehavior: "automatic",
    autoSkillFallbackNone: true,
    enabledSkillAllowlist: [],
    enabledOptionalTools,
  };
}

function registerStubTool(agent: ReturnType<typeof createAgentForParserTests>, name: string): void {
  agent.executor.registerTool({
    name,
    description: "test tool",
    definition: { name, description: "test tool", parameters: { type: "object", properties: {} } },
    execute: async () => ({ success: true, data: null }),
  });
}

describe("agent tool gating", () => {
  it("rejects an optional tool (e.g. shell) that is not in the enabled allowlist", async () => {
    const agent = createAgentForParserTests();
    registerStubTool(agent, "shell");

    const result = await asPrivate(agent).preflightToolInput("shell", { command: "ls" }, buildControls([]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/disabled/i);
    }
  });

  it("allows an optional tool once it is added to the enabled allowlist", async () => {
    const agent = createAgentForParserTests();
    registerStubTool(agent, "shell");

    const result = await asPrivate(agent).preflightToolInput("shell", { command: "ls" }, buildControls(["shell"]));

    expect(result.ok).toBe(true);
  });

  it("always allows a core tool (e.g. filesystem) regardless of the enabled allowlist", async () => {
    const agent = createAgentForParserTests();
    registerStubTool(agent, "filesystem");

    const result = await asPrivate(agent).preflightToolInput(
      "filesystem",
      { action: "list", path: "." },
      buildControls([])
    );

    expect(result.ok).toBe(true);
  });

  it("rejects an unknown tool before checking whether it is enabled", async () => {
    const agent = createAgentForParserTests();

    const result = await asPrivate(agent).preflightToolInput("not_a_real_tool", {}, buildControls([]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unknown tool/i);
    }
  });
});
