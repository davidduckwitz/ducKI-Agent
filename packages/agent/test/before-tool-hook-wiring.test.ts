import { describe, it, expect, vi } from "vitest";
import { Agent } from "../src/agent";
import { loadAgentRuntimeControls } from "../src/config/load-runtime-controls";

/**
 * Regression test for a bug where AgentOptions.hooks (specifically "beforeTool") were accepted
 * and registered into the HookRegistry, but nothing in the tool-call execution path ever called
 * hookRegistry.executeHooks("beforeTool", ...) - so every beforeTool hook (including CodingAgent's
 * read-before-edit discipline and its shell command approval policy) was silently inert. Fixed by
 * calling executeHookSafely(AGENT_HOOK_NAMES.BEFORE_TOOL, ...) per call in
 * executeToolCallsFromResponse, right after preflight validation.
 */
function buildAgent(hooks: any[]): Agent {
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
  return new Agent(provider, db, undefined, { enablePlanning: false, enableReflection: false, hooks });
}

describe("beforeTool hook wiring (agent.ts executeToolCallsFromResponse)", () => {
  it("blocks a tool call when a beforeTool hook returns proceed:false", async () => {
    const denyingHook = {
      name: "deny-everything",
      priority: 50,
      handler: async () => ({ proceed: false, reason: "denied by test hook" }),
    };
    const agent = buildAgent([denyingHook]);
    const execute = vi.fn(async () => ({ success: true, data: "should not run" }));
    (agent as any).executor.registerTool({
      name: "test_tool",
      description: "test tool",
      definition: { name: "test_tool", description: "test tool", parameters: { type: "object", properties: {} } },
      execute,
    });

    const controls = loadAgentRuntimeControls();
    const result = await (agent as any).executeToolCallsFromResponse(
      '[TOOL:test_tool({"command":"echo hi"})]',
      controls,
      {},
      () => {},
      1,
      new Map()
    );

    expect(execute).not.toHaveBeenCalled();
    const resultValues = Array.from(result.resultMap.values());
    expect(resultValues).toHaveLength(1);
    expect((resultValues[0] as any).success).toBe(false);
    expect((resultValues[0] as any).error).toContain("denied by test hook");
  });

  it("allows a tool call when the beforeTool hook approves it", async () => {
    const approvingHook = {
      name: "approve-everything",
      priority: 50,
      handler: async () => ({ proceed: true }),
    };
    const agent = buildAgent([approvingHook]);
    const execute = vi.fn(async () => ({ success: true, data: "ran" }));
    (agent as any).executor.registerTool({
      name: "test_tool",
      description: "test tool",
      definition: { name: "test_tool", description: "test tool", parameters: { type: "object", properties: {} } },
      execute,
    });

    const controls = loadAgentRuntimeControls();
    await (agent as any).executeToolCallsFromResponse(
      '[TOOL:test_tool({"command":"echo hi"})]',
      controls,
      {},
      () => {},
      1,
      new Map()
    );

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
