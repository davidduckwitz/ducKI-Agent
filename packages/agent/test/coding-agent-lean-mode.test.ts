import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "../src/coding/coding-agent";
import { resolveReasoningEffort } from "@ducki/providers";

/**
 * Lean mode (CODING_AGENT_LEAN_MODE, default on): one continuous agent loop, verification only
 * as the final gate, a failed check fed back into the SAME conversation. Plus the independently
 * switchable lean prompt, minimal reminders and default reasoning effort.
 */
function stubDb(settings: Record<string, string> = {}) {
  let nextId = 1;
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => Object.entries(settings).map(([key, value]) => ({ key, value })),
    getDynamicToolByName: async () => undefined,
    getSetting: async (key: string) => settings[key],
    createConversation: async (data: { name: string }) => ({ id: nextId++, name: data.name }),
  };
  return new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as any;
}

function stubProvider(name = "test", model = "test-model", seenEfforts: Array<string | undefined> = []) {
  const response = { content: "done", model, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  return {
    name,
    model,
    generate: async (_messages: unknown, options: any = {}) => {
      seenEfforts.push(resolveReasoningEffort(options));
      return response;
    },
    generateStream: async () => response,
    supportsStreaming: () => false,
  } as any;
}

function spyOnRuns(codingAgent: CodingAgent) {
  const innerAgent = (codingAgent as any).agent;
  const calls: Array<{ prompt: string; options: any }> = [];
  const realRun = innerAgent.run.bind(innerAgent);
  innerAgent.run = (async (prompt: string, options: any = {}) => {
    calls.push({ prompt, options });
    return realRun(prompt, options);
  }) as typeof innerAgent.run;
  return { innerAgent, calls };
}

describe("CodingAgent lean mode", () => {
  it("runs without the Planner and finishes verified when the check passes", async () => {
    const codingAgent = new CodingAgent(stubProvider(), stubDb(), undefined, {});
    const { innerAgent, calls } = spyOnRuns(codingAgent);
    let plannerCalls = 0;
    (codingAgent as any).planner.createPlan = async () => { plannerCalls++; throw new Error("planner must not run"); };
    (innerAgent.executor as any).execute = async () => ({ success: true, data: { stdout: "ok" } });

    const result = await codingAgent.run("add a feature", { verifyCommand: "npm test" });

    expect(plannerCalls).toBe(0);
    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("add a feature");
    expect(calls[0]!.prompt).toContain("npm test");
  });

  it("feeds a failed verification back into the same conversation as the next turn", async () => {
    const codingAgent = new CodingAgent(stubProvider(), stubDb(), undefined, {});
    const { innerAgent, calls } = spyOnRuns(codingAgent);
    let verifyRuns = 0;
    (innerAgent.executor as any).execute = async () => {
      verifyRuns++;
      return verifyRuns === 1
        ? { success: false, data: null, error: "TypeError: x is undefined at app.ts:12" }
        : { success: true, data: { stdout: "ok" } };
    };

    const result = await codingAgent.run("fix the bug", { verifyCommand: "npm test", maxAttempts: 3 });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("TypeError: x is undefined at app.ts:12");
    // Only the goal is persisted as a user turn - the follow-up continues the same conversation.
    expect(calls[0]!.options.persistUserTurn).toBe(true);
    expect(calls[1]!.options.persistUserTurn).toBe(false);
  });

  it("stops on a non-converging identical verification error", async () => {
    const codingAgent = new CodingAgent(stubProvider(), stubDb(), undefined, {});
    const { innerAgent } = spyOnRuns(codingAgent);
    (innerAgent.executor as any).execute = async () => ({ success: false, data: null, error: "same error" });

    const result = await codingAgent.run("fix", { verifyCommand: "npm test", maxAttempts: 5 });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.summary).toContain("exact same verification error");
  });

  it("passes the lean system prompt with the project's AGENTS.md and minimal reminders", async () => {
    const root = mkdtempSync(join(tmpdir(), "ducki-lean-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "Always use tabs for indentation.");
      const codingAgent = new CodingAgent(stubProvider(), stubDb(), undefined, { sandboxRoot: root });
      const { innerAgent, calls } = spyOnRuns(codingAgent);
      (innerAgent.executor as any).execute = async () => ({ success: true, data: {} });

      await codingAgent.run("tweak", { verifyCommand: "npm test" });

      const options = calls[0]!.options;
      expect(options.systemPromptOverride).toContain("# Doing tasks");
      expect(options.systemPromptOverride).toContain("Always use tabs for indentation.");
      expect(options.systemPromptOverride).toContain(`Project root: ${root}`);
      expect(options.minimalReminders).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("each switch can be turned off independently", async () => {
    const codingAgent = new CodingAgent(stubProvider(), stubDb({
      CODING_AGENT_LEAN_PROMPT: "false",
      CODING_AGENT_MINIMAL_REMINDERS: "false",
    }), undefined, {});
    const { innerAgent, calls } = spyOnRuns(codingAgent);
    (innerAgent.executor as any).execute = async () => ({ success: true, data: {} });

    await codingAgent.run("tweak", { verifyCommand: "npm test" });

    expect(calls[0]!.options.systemPromptOverride).toBeUndefined();
    expect(calls[0]!.options.minimalReminders).toBeUndefined();
  });

  it("uses the classic Planner controller when lean mode is switched off", async () => {
    const codingAgent = new CodingAgent(stubProvider(), stubDb({ CODING_AGENT_LEAN_MODE: "false" }), undefined, {});
    const { innerAgent } = spyOnRuns(codingAgent);
    let plannerCalls = 0;
    const planner = (codingAgent as any).planner;
    const realCreatePlan = planner.createPlan.bind(planner);
    planner.createPlan = async (...args: unknown[]) => { plannerCalls++; return realCreatePlan(...args); };
    (innerAgent.executor as any).execute = async () => ({ success: true, data: {} });

    await codingAgent.run("tweak", { verifyCommand: "npm test" });

    expect(plannerCalls).toBe(1);
  });
});

describe("CodingAgent default reasoning effort", () => {
  it("enables thinking for a Claude model that supports it", async () => {
    const efforts: Array<string | undefined> = [];
    const codingAgent = new CodingAgent(stubProvider("claude", "claude-haiku-4-5", efforts), stubDb(), undefined, {});
    await codingAgent.run("tweak", {});
    expect(efforts.length).toBeGreaterThan(0);
    expect(efforts.every((effort) => effort === "medium")).toBe(true);
  });

  it("uses the configured effort and respects the off switch", async () => {
    const high: Array<string | undefined> = [];
    await new CodingAgent(stubProvider("openrouter", "anthropic/claude-sonnet-5", high),
      stubDb({ CODING_AGENT_THINKING_EFFORT: "high" }), undefined, {}).run("tweak", {});
    expect(high.every((effort) => effort === "high")).toBe(true);

    const off: Array<string | undefined> = [];
    await new CodingAgent(stubProvider("claude", "claude-haiku-4-5", off),
      stubDb({ CODING_AGENT_EXTENDED_THINKING: "false" }), undefined, {}).run("tweak", {});
    expect(off.every((effort) => effort === undefined)).toBe(true);
  });

  it("leaves non-reasoning OpenAI models and local providers alone unless enabled", async () => {
    const gpt4o: Array<string | undefined> = [];
    await new CodingAgent(stubProvider("openai", "gpt-4o", gpt4o), stubDb(), undefined, {}).run("tweak", {});
    expect(gpt4o.every((effort) => effort === undefined)).toBe(true);

    const local: Array<string | undefined> = [];
    await new CodingAgent(stubProvider("lmstudio", "qwen3", local), stubDb(), undefined, {}).run("tweak", {});
    expect(local.every((effort) => effort === undefined)).toBe(true);

    const localOn: Array<string | undefined> = [];
    await new CodingAgent(stubProvider("lmstudio", "qwen3", localOn),
      stubDb({ CODING_AGENT_EXTENDED_THINKING_LOCAL: "true" }), undefined, {}).run("tweak", {});
    expect(localOn.every((effort) => effort === "medium")).toBe(true);
  });

  it("an explicit per-run effort wins over the setting", async () => {
    const efforts: Array<string | undefined> = [];
    await new CodingAgent(stubProvider("claude", "claude-haiku-4-5", efforts), stubDb(), undefined, {})
      .run("tweak", { reasoningEffort: "low" });
    expect(efforts.every((effort) => effort === "low")).toBe(true);
  });
});
