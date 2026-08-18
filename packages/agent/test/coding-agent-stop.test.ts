import { describe, it, expect, vi } from "vitest";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * Regression coverage for the fix that lets a caller cancel a CodingAgent run started outside
 * a socket (an HTTP route) - previously there was no way at all to stop such a run, and no way
 * to even learn its conversationId before the whole run finished.
 */
function stubDb() {
  let nextId = 1;
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
    createConversation: async (data: { name: string }) => ({ id: nextId++, name: data.name }),
  };
  return new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as any;
}

function stubProvider() {
  return {
    model: "test-model",
    generate: async () => ({ content: "done", model: "test-model", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
    generateStream: async () => ({ content: "done", model: "test-model", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
    supportsStreaming: () => false,
  } as any;
}

describe("CodingAgent.stop()", () => {
  it("delegates to the underlying Agent's stop()", () => {
    const codingAgent = new CodingAgent(stubProvider(), stubDb(), undefined, {});
    const innerAgent = (codingAgent as any).agent;
    const stopSpy = vi.spyOn(innerAgent, "stop");

    codingAgent.stop();

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});

describe("CodingRunOptions.onConversationStarted", () => {
  it("fires with the conversationId before the run finishes, not just at the end", async () => {
    const codingAgent = new CodingAgent(stubProvider(), stubDb(), undefined, {});
    const seen: number[] = [];

    const result = await codingAgent.run("do the thing", {
      onConversationStarted: (conversationId) => seen.push(conversationId),
    });

    expect(seen).toHaveLength(1);
    expect(result.conversationId).toBe(seen[0]);
  });
});
