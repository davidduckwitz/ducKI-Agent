import { describe, it, expect } from "vitest";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * Regression coverage for a real bug found while auditing the coding-agent's Plan tab: every
 * CodingAgent event (plan/decision/phase) was a pure WebSocket broadcast with no DB row at all
 * (see emitPlanEvent/emit in coding-agent.ts before this fix) - so switching projects/
 * conversations, refreshing the page, or resuming a stopped run after the process restarted a
 * fresh CodingAgent instance had NOTHING to reconstruct the plan or checklist progress from.
 * These tests cover both halves of the fix: persistence (a "plan"/"decision" event actually
 * lands in the DB) and rehydration (a resumed run() recovers that state instead of re-planning
 * and restarting the checklist at step 1).
 */
function makeMemoryDb() {
  let nextConversationId = 1;
  let nextMessageId = 1;
  const conversations = new Map<number, { id: number; name: string }>();
  const messages: Array<Record<string, unknown>> = [];

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
  };
  const db = new Proxy(known, {
    get: (t, p: string) => (p in t ? t[p] : async () => undefined),
  }) as any;
  return { db, messages };
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
  steps: [
    { id: "step_1", title: "Step A" },
    { id: "step_2", title: "Step B" },
  ],
});

describe("CodingAgent plan/checklist persistence", () => {
  it("persists a 'plan' event to the DB with the exact internal Plan object", async () => {
    const { db, messages } = makeMemoryDb();
    const provider = scriptedProvider([PLAN_JSON, "Fertig."]);
    const agent = new CodingAgent(provider, db, undefined, {});
    (agent as any).agent.enablePlanning = false;

    await agent.run("build the thing", { maxAttempts: 1 });

    const planRows = messages.filter((m) => {
      try {
        return JSON.parse(String(m["toolResult"])).eventType === "plan";
      } catch {
        return false;
      }
    });
    expect(planRows).toHaveLength(1);
    const data = JSON.parse(String(planRows[0]!["toolResult"])).data;
    expect(data.__rawPlan.goal).toBe("build the thing");
    expect(data.__rawPlan.steps).toHaveLength(2);
  });

  it("persists 'decision' events (todo_items) as the checklist changes", async () => {
    const { db, messages } = makeMemoryDb();
    const provider = scriptedProvider([
      PLAN_JSON,
      "[TOOL:todo action=update id=1 status=done]",
      "Fertig.",
    ]);
    const agent = new CodingAgent(provider, db, undefined, {});
    (agent as any).agent.enablePlanning = false;

    await agent.run("build the thing", { maxAttempts: 1 });

    // Several "decision" events fire this run (checklist updates, the end-of-run "no
    // verification possible" note) - only the checklist ones carry todo_items.
    const todoDecisionRows = messages.filter((m) => {
      try {
        const parsed = JSON.parse(String(m["toolResult"]));
        return parsed.eventType === "decision" && Array.isArray(parsed.data?.todo_items);
      } catch {
        return false;
      }
    });
    expect(todoDecisionRows.length).toBeGreaterThan(0);
    const last = JSON.parse(String(todoDecisionRows[todoDecisionRows.length - 1]!["toolResult"])).data;
    expect(last.todo_items.find((i: any) => i.id === 1)?.status).toBe("done");
  });

  it("resuming the same conversation rehydrates the plan and checklist instead of starting over", async () => {
    const { db } = makeMemoryDb();

    // Run 1: plans, marks step 1 done, then the process/instance "goes away" (a fresh
    // CodingAgent is created for run 2, exactly like a new HTTP request would in production -
    // no in-memory state survives, only what is in the DB).
    const provider1 = scriptedProvider([
      PLAN_JSON,
      "[TOOL:todo action=update id=1 status=done]",
      "Fertig.",
    ]);
    const agent1 = new CodingAgent(provider1, db, undefined, {});
    (agent1 as any).agent.enablePlanning = false;
    const result1 = await agent1.run("build the thing", { maxAttempts: 1 });
    const conversationId = result1.conversationId!;
    expect(conversationId).toBeGreaterThan(0);

    // Run 2: a BRAND NEW instance, same conversationId, no existingPlan supplied. If rehydration
    // works, this must recover the plan (2 steps, "Step A"/"Step B") and the checklist (step 1
    // already done) WITHOUT calling the Planner again - the scripted provider below has no plan
    // JSON at all, so a Planner call here would produce a fallback/garbage plan instead.
    const provider2 = scriptedProvider(["Fertig."]);
    const agent2 = new CodingAgent(provider2, db, undefined, {});
    (agent2 as any).agent.enablePlanning = false;

    await agent2.run("build the thing", { conversationId, maxAttempts: 1 });

    const todos = (agent2 as any).todos.snapshot();
    expect(todos).toHaveLength(2);
    expect(todos.find((t: any) => t.title === "Step A")?.status).toBe("done");
    expect(todos.find((t: any) => t.title === "Step B")?.status).toBe("pending");
  });

  it("a caller-supplied existingPlan always wins over rehydrated state", async () => {
    const { db } = makeMemoryDb();
    const provider1 = scriptedProvider([PLAN_JSON, "[TOOL:todo action=update id=1 status=done]", "Fertig."]);
    const agent1 = new CodingAgent(provider1, db, undefined, {});
    (agent1 as any).agent.enablePlanning = false;
    const result1 = await agent1.run("build the thing", { maxAttempts: 1 });
    const conversationId = result1.conversationId!;

    const overridePlan = {
      goal: "a completely different goal",
      estimatedComplexity: "low" as const,
      steps: [{ id: "x", title: "Different Step", status: "pending" as const }],
    };
    const provider2 = scriptedProvider(["Fertig."]);
    const agent2 = new CodingAgent(provider2, db, undefined, {});
    (agent2 as any).agent.enablePlanning = false;
    await agent2.run("build the thing", { conversationId, maxAttempts: 1, existingPlan: overridePlan as any });

    const todos = (agent2 as any).todos.snapshot();
    expect(todos).toHaveLength(1);
    expect(todos[0].title).toBe("Different Step");
    expect(todos[0].status).toBe("pending");
  });
});
