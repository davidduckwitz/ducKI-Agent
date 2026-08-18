import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent";

/**
 * Regression test for a double-counting bug: the "LLM response received" event used to emit a
 * combinedTokens.total that added a chars/4 ESTIMATE of the system prompt/tools/skills
 * (agentTokens.total) ON TOP OF the provider's real usage (llmTokens.input) - even though that
 * same system prompt content was already part of the messages the provider counted. For a large
 * CodingAgent-sized system prompt this inflated the displayed "Combined Total" by thousands of
 * tokens per call. Fixed by dropping the addition (and the redundant combinedTokens field
 * entirely) - agentTokens is now purely an informational breakdown of what's already inside
 * llmTokens.input, never summed with it.
 */
function stubDb() {
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
  };
  return new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as any;
}

describe("token usage reporting (no double-counting)", () => {
  it("does not add agentTokens on top of the provider's real usage, and drops combinedTokens", async () => {
    const provider = {
      model: "test-model",
      generate: async () => ({
        content: "hello",
        model: "test-model",
        usage: { promptTokens: 500, completionTokens: 10, totalTokens: 510 },
      }),
      generateStream: async () => ({
        content: "hello",
        model: "test-model",
        usage: { promptTokens: 500, completionTokens: 10, totalTokens: 510 },
      }),
      supportsStreaming: () => false,
    } as any;

    const agent = new Agent(provider, stubDb(), undefined, { enablePlanning: false, enableReflection: false });

    const events: Array<{ type: string; message: string; data?: Record<string, unknown> }> = [];
    await agent.run("say hello", { onEvent: (event) => { events.push(event as any); } });

    const llmEvent = events.find((e) => e.message === "LLM response received");
    expect(llmEvent).toBeDefined();

    const llmTokens = llmEvent!.data!["llmTokens"] as { input: number; output: number; total: number };
    expect(llmTokens.input).toBe(500);
    expect(llmTokens.output).toBe(10);
    expect(llmTokens.total).toBe(510);

    // The bug: this used to exist and equal llmTokens.input + agentTokens.total (hundreds of
    // extra tokens that were already counted inside llmTokens.input).
    expect(llmEvent!.data).not.toHaveProperty("combinedTokens");
  });
});
