import { describe, it, expect } from "vitest";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * Regression coverage for the deferred idea landed here: when the model rewrites the checklist
 * (todo:write) after exploration shows the drafted plan needs to change - something
 * buildInitialPrompt explicitly invites it to do - the Plan tab's underlying Plan object used to
 * stay frozen at whatever the Planner originally produced. A step the model renamed/added/
 * dropped had no matching title in that stale plan, so the Plan tab either kept showing steps
 * that no longer existed or failed to resolve status for new ones - the "plan looks reset /
 * forgot to check something off" symptom. syncPlanFromTodos (wired via TodoList's new onReplace
 * callback) is the fix: a structural todo:write now re-derives and re-emits the Plan's step list
 * from the checklist itself.
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
  const db = new Proxy(known, { get: (t, p: string) => (p in t ? t[p] : async () => undefined) }) as any;
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
    { id: "step_1", title: "Step A", description: "original description A" },
    { id: "step_2", title: "Step B", description: "original description B" },
  ],
});

function lastPlanRow(messages: Array<Record<string, unknown>>) {
  const planRows = messages.filter((m) => {
    try {
      return JSON.parse(String(m["toolResult"])).eventType === "plan";
    } catch {
      return false;
    }
  });
  return JSON.parse(String(planRows[planRows.length - 1]!["toolResult"])).data;
}

describe("CodingAgent syncs the Plan when the model rewrites the checklist", () => {
  it("a todo:write that renames/adds steps re-emits the plan with the new step set", async () => {
    const { db, messages } = makeMemoryDb();
    const provider = scriptedProvider([
      PLAN_JSON,
      '[TOOL:todo({"action":"write","items":[{"title":"Step A"},{"title":"New Step C"}]})]',
      "Fertig.",
    ]);
    const agent = new CodingAgent(provider, db, undefined, {});
    (agent as any).agent.enablePlanning = false;

    await agent.run("build the thing", { maxAttempts: 1 });

    const data = lastPlanRow(messages);
    const titles = data.__rawPlan.steps.map((s: any) => s.title);
    expect(titles).toEqual(["Step A", "New Step C"]);
    // "Step B" is gone from the re-synced plan - it was dropped by the rewrite.
    expect(titles).not.toContain("Step B");
  });

  it("preserves the original step's metadata when its title is unchanged", async () => {
    const { db, messages } = makeMemoryDb();
    const provider = scriptedProvider([
      PLAN_JSON,
      '[TOOL:todo({"action":"write","items":[{"title":"Step A"},{"title":"Step B"}]})]',
      "Fertig.",
    ]);
    const agent = new CodingAgent(provider, db, undefined, {});
    (agent as any).agent.enablePlanning = false;

    await agent.run("build the thing", { maxAttempts: 1 });

    const data = lastPlanRow(messages);
    const stepA = data.__rawPlan.steps.find((s: any) => s.title === "Step A");
    expect(stepA.description).toBe("original description A");
  });

  it("a plain status update keeps the persisted plan status in sync", async () => {
    const { db, messages } = makeMemoryDb();
    const provider = scriptedProvider([PLAN_JSON, "[TOOL:todo action=update id=1 status=done]", "Fertig."]);
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
    expect(planRows).toHaveLength(2);
    const latest = JSON.parse(String(planRows.at(-1)?.["toolResult"]));
    expect(latest.data.__rawPlan.steps[0].status).toBe("completed");
  });

  it("does not emit a redundant second plan event for CodingAgent's own initial checklist seed", async () => {
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
  });

  it("maps todo status onto the plan step's status vocabulary", async () => {
    const { db, messages } = makeMemoryDb();
    const provider = scriptedProvider([
      PLAN_JSON,
      '[TOOL:todo({"action":"write","items":[{"title":"Step A","status":"done"},{"title":"Step B","status":"blocked"}]})]',
      "Fertig.",
    ]);
    const agent = new CodingAgent(provider, db, undefined, {});
    (agent as any).agent.enablePlanning = false;

    await agent.run("build the thing", { maxAttempts: 1 });

    const data = lastPlanRow(messages);
    expect(data.__rawPlan.steps.find((s: any) => s.title === "Step A").status).toBe("completed");
    expect(data.__rawPlan.steps.find((s: any) => s.title === "Step B").status).toBe("failed");
  });
});
