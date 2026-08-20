import { describe, it, expect, vi } from "vitest";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * Regression coverage for the duplicate-session bug: executing a plan from the normal chat
 * called POST /api/coding-agent/run, which ran CodingAgent.run() with no conversation - so the
 * agent opened its own "CodingAgent: <goal>" conversation. The user ended up with TWO sessions
 * in the sidebar for one action: the chat they were watching, and a second one that silently
 * held the entire run transcript.
 */
function stubDb(options: { existingConversations?: number[] } = {}) {
  const existing = new Set(options.existingConversations ?? []);
  let nextId = 100;
  const createConversation = vi.fn(async (data: { name: string }) => ({ id: nextId++, name: data.name }));
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
    createConversation,
    getConversation: async (id: number) => (existing.has(id) ? { id, name: `conversation ${id}` } : undefined),
    getMessages: async () => [],
  };
  const db = new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as any;
  return { db, createConversation };
}

function stubProvider() {
  return {
    model: "test-model",
    generate: async () => ({ content: "done", model: "test-model", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
    generateStream: async () => ({ content: "done", model: "test-model", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
    supportsStreaming: () => false,
  } as any;
}

describe("CodingRunOptions.conversationId", () => {
  it("runs inside the given conversation instead of opening a second one", async () => {
    const { db, createConversation } = stubDb({ existingConversations: [42] });
    const codingAgent = new CodingAgent(stubProvider(), db, undefined, {});

    const result = await codingAgent.run("implement the plan", { conversationId: 42 });

    expect(createConversation).not.toHaveBeenCalled();
    expect(result.conversationId).toBe(42);
  });

  it("still reports the joined conversation through onConversationStarted", async () => {
    // The callback is what registers the run so the Stop button can find it - a joined
    // conversation needs that just as much as a freshly created one.
    const { db } = stubDb({ existingConversations: [42] });
    const codingAgent = new CodingAgent(stubProvider(), db, undefined, {});
    const seen: number[] = [];

    await codingAgent.run("implement the plan", {
      conversationId: 42,
      onConversationStarted: (conversationId) => seen.push(conversationId),
    });

    expect(seen).toEqual([42]);
  });

  it("opens its own conversation when none is given (headless cronjob runs)", async () => {
    const { db, createConversation } = stubDb();
    const codingAgent = new CodingAgent(stubProvider(), db, undefined, {});

    const result = await codingAgent.run("implement the plan");

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(result.conversationId).toBe(100);
  });

  it("ignores a nonsensical id rather than joining conversation 0 or NaN", async () => {
    const { db, createConversation } = stubDb();
    const codingAgent = new CodingAgent(stubProvider(), db, undefined, {});

    await codingAgent.run("implement the plan", { conversationId: 0 });
    await codingAgent.run("implement the plan", { conversationId: Number.NaN });

    expect(createConversation).toHaveBeenCalledTimes(2);
  });
});
