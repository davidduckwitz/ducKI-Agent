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
    updatePlan: async (id: number, data: Record<string, unknown>) => {
      const row = plans.find((p) => p["id"] === id);
      if (!row) return undefined;
      Object.assign(row, data, { updatedAt: new Date().toISOString() });
      return row;
    },
  };
  const db = new Proxy(known, { get: (t, p: string) => (p in t ? t[p] : async () => undefined) }) as any;
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

  it("keeps the persisted plans-table row's step statuses in sync too, not just the event", async () => {
    // Regression: the Plan tab falls back to the plans-table row (GET /plans?conversationId=)
    // once the live "plan"/"decision" events age out of the paginated message window - see
    // checklistFromPlanSteps (apps/web/src/lib/planChecklist.ts). If this row's steps stayed
    // frozen at their original all-pending shape, that fallback would show the plan but with
    // progress reset to nothing done, even though the run had completed steps.
    const { db, plans } = makeMemoryDb();
    const provider = scriptedProvider([PLAN_JSON, "[TOOL:todo action=update id=1 status=done]", "Fertig."]);
    const agent = new CodingAgent(provider, db, undefined, {});
    (agent as any).agent.enablePlanning = false;

    await agent.run("build the thing", { maxAttempts: 1 });

    expect(plans).toHaveLength(1);
    const steps = JSON.parse(plans[0]!["steps"] as string);
    expect(steps.find((s: any) => s.title === "Step A").status).toBe("completed");
    expect(steps.find((s: any) => s.title === "Step B").status).toBe("pending");
  });

  it("also syncs the plans-table row for a plan started from opts.existingPlan (UI-triggered execution)", async () => {
    // Regression: /plans/:id/execute (and the Plan tab's "Ausfuehren"/auto-execute-after-
    // refine paths) always runs with opts.existingPlan since the caller already owns that
    // plans-table row - CodingAgent used to leave currentPlanDb undefined for that whole case,
    // silently disabling the write-back below for EVERY plan run started from the UI. Once the
    // live "plan"/"decision" events aged out of the paginated message window, the Plan tab and
    // checklist both fell back to this exact row and found it frozen at its original all-pending
    // shape - looking like the run had lost track of its own progress.
    const { db, plans } = makeMemoryDb();
    const seeded = await db.createPlan({
      conversationId: 1,
      goal: "build the thing",
      title: "build the thing",
      complexity: 1,
      steps: JSON.stringify([
        { id: "step_1", title: "Step A", status: "pending" },
        { id: "step_2", title: "Step B", status: "pending" },
      ]),
      tools: "[]",
      markdown: "",
      status: "active",
      version: 1,
      parentPlanId: null,
      repositorySnapshot: null,
    });

    const provider = scriptedProvider(["[TOOL:todo action=update id=1 status=done]", "Fertig."]);
    const codingAgent = new CodingAgent(provider, db, undefined, {});
    (codingAgent as any).agent.enablePlanning = false;

    await codingAgent.run("build the thing", {
      maxAttempts: 1,
      existingPlan: {
        goal: "build the thing",
        planType: "coding",
        estimatedComplexity: "low",
        steps: [
          { id: "step_1", title: "Step A", status: "pending" },
          { id: "step_2", title: "Step B", status: "pending" },
        ],
      } as any,
      planRunContext: { planId: seeded.id, planVersion: 1, runId: "test-run" },
    });

    expect(plans).toHaveLength(1); // still no NEW row created
    const steps = JSON.parse(plans[0]!["steps"] as string);
    expect(steps.find((s: any) => s.title === "Step A").status).toBe("completed");
    expect(steps.find((s: any) => s.title === "Step B").status).toBe("pending");
  });
});
