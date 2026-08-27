import { describe, it, expect } from "vitest";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * Regression coverage: a plan CodingAgent creates itself was previously broadcast ONLY as a
 * "plan" event message row - never written to the `plans` table the /plans REST routes (and the
 * Plan panel's version history) actually query. Because the coding chat's message list is
 * paginated (most recent 40), a run with enough follow-up iterations pushes that one early plan
 * event out of the loaded window, and the Plan tab - which derived its plan purely from a scan
 * over currently-loaded messages - went blank mid-run even though the agent was still actively
 * working from that exact plan. Fix: persist to `plans` too, with id/version riding along on the
 * event payload, so the frontend can look the SAME plan up independently via
 * GET /plans?conversationId=... regardless of the message window.
 */
function makeMemoryDb() {
  let nextConversationId = 1;
  let nextMessageId = 1;
  let nextPlanId = 1;
  const conversations = new Map<number, { id: number; name: string }>();
  const messages: Array<Record<string, unknown>> = [];
  const plans: Array<Record<string, unknown>> = [];

  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
    createConversation: async (data: { name: string }) => {
      const conv = { id: nextConversationId++, name: data.name };
      conversations.set(conv.id, conv);
      return conv;
    },
    getConversation: async (id: number) => conversations.get(id),
    addMessage: async (data: Record<string, unknown>) => {
      const row = { id: nextMessageId++, ...data };
      messages.push(row);
      return row;
    },
    getMessages: async (conversationId: number) => messages.filter((m) => m["conversationId"] === conversationId),
    createPlan: async (data: Record<string, unknown>) => {
      const now = new Date().toISOString();
      const row = { id: nextPlanId++, createdAt: now, updatedAt: now, ...data };
      plans.push(row);
      return row;
    },
    listPlans: async (filters: { conversationId?: number }) =>
      plans.filter((p) => filters.conversationId === undefined || p["conversationId"] === filters.conversationId),
  };
  const db = new Proxy(known, {
    get: (t, p: string) => (p in t ? t[p] : async () => undefined),
  }) as any;
  return { db, messages, plans };
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
  estimatedComplexity: "medium",
  steps: [
    { id: "step_1", title: "Step A", toolsNeeded: ["filesystem"] },
    { id: "step_2", title: "Step B" },
  ],
});

describe("CodingAgent plan persistence to the plans table", () => {
  it("persists a freshly-created plan to the plans table, findable by conversationId", async () => {
    const { db, plans } = makeMemoryDb();
    const provider = scriptedProvider([PLAN_JSON, "Fertig."]);
    const codingAgent = new CodingAgent(provider, db, undefined, {});
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("build the thing", { maxAttempts: 1 });

    expect(plans).toHaveLength(1);
    const row = plans[0]!;
    expect(row["conversationId"]).toBe(result.conversationId);
    expect(row["goal"]).toBe("build the thing");
    expect(JSON.parse(row["steps"] as string)).toHaveLength(2);
    expect(row["version"]).toBe(1);
    expect(row["status"]).toBe("draft");

    const listed = await db.listPlans({ conversationId: result.conversationId });
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(row["id"]);
  });

  it("carries the persisted plan's id/version on the emitted 'plan' event", async () => {
    const { db, messages } = makeMemoryDb();
    const provider = scriptedProvider([PLAN_JSON, "Fertig."]);
    const codingAgent = new CodingAgent(provider, db, undefined, {});
    (codingAgent as any).agent.enablePlanning = false;

    await codingAgent.run("build the thing", { maxAttempts: 1 });

    const planEventRow = messages.find((m) => {
      if (m["role"] !== "event") return false;
      try {
        return JSON.parse(m["toolResult"] as string).eventType === "plan";
      } catch {
        return false;
      }
    });
    expect(planEventRow).toBeDefined();
    const parsed = JSON.parse(planEventRow!["toolResult"] as string);
    expect(typeof parsed.data.id).toBe("number");
    expect(parsed.data.version).toBe(1);
  });

  it("does not persist a plan the caller already supplied (opts.existingPlan)", async () => {
    const { db, plans } = makeMemoryDb();
    const provider = scriptedProvider(["Fertig."]);
    const codingAgent = new CodingAgent(provider, db, undefined, {});
    (codingAgent as any).agent.enablePlanning = false;

    await codingAgent.run("build the thing", {
      maxAttempts: 1,
      existingPlan: {
        goal: "build the thing",
        planType: "coding",
        estimatedComplexity: "low",
        steps: [{ id: "step_1", title: "Step A", status: "pending" }],
      } as any,
    });

    expect(plans).toHaveLength(0);
  });
});
