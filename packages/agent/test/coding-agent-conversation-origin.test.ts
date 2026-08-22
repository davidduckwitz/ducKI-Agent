import { describe, it, expect } from "vitest";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * Regression coverage: every conversation CodingAgent.run() opens for itself is tagged
 * origin="coding_agent" so the normal chat overview excludes it by default (it's already
 * visible in the Coding area) - see the conversations.origin schema comment. A conversation
 * CodingAgent RESUMES (opts.conversationId) must NEVER be retagged, since it may well be a
 * normal chat the user started (e.g. Plan execution reusing the chat it was planned in).
 */
function makeMemoryDb() {
  let nextConversationId = 1;
  const conversations = new Map<number, Record<string, unknown>>();
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
    createConversation: async (data: Record<string, unknown>) => {
      const conv = { id: nextConversationId++, ...data };
      conversations.set(conv.id as number, conv);
      return conv;
    },
    getConversation: async (id: number) => conversations.get(id),
    updateConversation: async (id: number, data: Record<string, unknown>) => {
      const existing = conversations.get(id) ?? {};
      const updated = { ...existing, ...data };
      conversations.set(id, updated);
      return updated;
    },
    addMessage: async (data: Record<string, unknown>) => ({ id: 1, ...data }),
    getMessages: async () => [],
  };
  const db = new Proxy(known, { get: (t, p: string) => (p in t ? t[p] : async () => undefined) }) as any;
  return { db, conversations };
}

function scriptedProvider(contents: string[]) {
  let index = 0;
  const next = () => {
    const content = contents[Math.min(index, contents.length - 1)] ?? "Fertig.";
    index++;
    return {
      content,
      model: "test-model",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    };
  };
  return {
    model: "test-model",
    generate: async () => next(),
    generateStream: async () => next(),
    supportsStreaming: () => false,
  } as any;
}

const PLAN_JSON = JSON.stringify({
  goal: "build the thing",
  estimatedComplexity: "low",
  steps: [{ id: "step_1", title: "Step A" }],
});

describe("CodingAgent tags conversations it creates with origin=coding_agent", () => {
  it("tags a freshly-created conversation", async () => {
    const { db, conversations } = makeMemoryDb();
    const provider = scriptedProvider([PLAN_JSON, "Fertig."]);
    const agent = new CodingAgent(provider, db, undefined, {});
    (agent as any).agent.enablePlanning = false;

    const result = await agent.run("build the thing", { maxAttempts: 1 });

    const conv = conversations.get(result.conversationId!);
    expect(conv?.["origin"]).toBe("coding_agent");
  });

  it("does NOT retag a conversation it is resuming (may be a normal chat)", async () => {
    const { db, conversations } = makeMemoryDb();
    // Simulate a normal chat conversation that already exists, untagged.
    conversations.set(42, { id: 42, name: "A normal chat", origin: undefined });

    const provider = scriptedProvider(["Fertig."]);
    const agent = new CodingAgent(provider, db, undefined, {});
    (agent as any).agent.enablePlanning = false;

    await agent.run("do a follow-up thing", {
      conversationId: 42,
      maxAttempts: 1,
      existingPlan: { goal: "x", estimatedComplexity: "low" as const, steps: [] },
    });

    expect(conversations.get(42)?.["origin"]).toBeUndefined();
  });
});
