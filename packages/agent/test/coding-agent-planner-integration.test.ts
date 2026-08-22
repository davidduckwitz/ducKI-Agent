import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "../src/coding/coding-agent.js";

/**
 * The Planner now runs BEFORE the first attempt so the todo checklist is seeded with real,
 * detailed steps instead of staying empty until the model gets around to calling todo:write
 * itself (see coding-agent.ts run()). This pins that: the very first provider.generate() call is
 * the Planner's, and the checklist must reflect its steps even before any tool call happened.
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

function scriptedProvider(contents: string[]) {
  let index = 0;
  const next = () => {
    const content = contents[Math.min(index, contents.length - 1)] ?? "done";
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

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
});

const PLAN_JSON = JSON.stringify({
  goal: "Add a health endpoint",
  planType: "coding",
  steps: [
    { id: "step_1", title: "Read the router file", description: "Find where routes are registered" },
    { id: "step_2", title: "Add the /health route", description: "Return 200 OK" },
  ],
  estimatedComplexity: "low",
});

describe("CodingAgent + Planner integration", () => {
  it("seeds the todo checklist from the Planner's steps before the first attempt", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-planner-"));
    sandboxes.push(sandbox);
    // First generate() call is the Planner's (expects JSON back); second is the agent's own
    // turn, which does nothing so the attempt stays a no-op.
    const provider = scriptedProvider([PLAN_JSON, "Fertig."]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    await codingAgent.run("add a health endpoint", { maxAttempts: 1 });

    const todos = (codingAgent as any).todos.snapshot() as Array<{ title: string; status: string }>;
    expect(todos.map((t) => t.title)).toEqual(["Read the router file", "Add the /health route"]);
    expect(todos.every((t) => t.status === "pending")).toBe(true);
  });

  it("uses a caller-supplied plan as-is instead of calling the Planner again", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-planner-existing-"));
    sandboxes.push(sandbox);
    // Only ONE scripted response: if the Planner were called too, this would be consumed by
    // it and the agent's own turn would fall through to the last (repeated) entry - fine
    // either way, but the todo assertion below only passes if existingPlan was actually used.
    const provider = scriptedProvider(["Fertig."]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    await codingAgent.run("add a health endpoint", {
      maxAttempts: 1,
      existingPlan: {
        goal: "Add a health endpoint",
        planType: "coding",
        steps: [
          { id: "step_1", title: "Pre-reviewed step", description: "Already approved by the user", status: "pending" },
        ],
        estimatedComplexity: "low",
      },
    });

    const todos = (codingAgent as any).todos.snapshot() as Array<{ title: string; status: string }>;
    expect(todos.map((t) => t.title)).toEqual(["Pre-reviewed step"]);
  });
});
