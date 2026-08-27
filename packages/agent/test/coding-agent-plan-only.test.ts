import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * "Plan Mode" in the coding chat composer promises "nur einen Plan erstellen, nichts
 * ausfuehren" (only create a plan, execute nothing). This pins CodingRunOptions.planOnly:
 *  - the plan is created and reported, the EXPLORE/EDIT/VERIFY attempt loop never runs;
 *  - a bounded investigation sub-run (read/browse/read-only-shell) is allowed to ground the
 *    plan, but every mutating filesystem/git call and every non-read-only shell command is
 *    hard-refused for its whole duration, with no bypass;
 *  - that investigation is capped at PLAN_ONLY_EXPLORE_MAX_ITERATIONS tool calls.
 */
function stubDb(settings: Record<string, string> = {}) {
  let nextId = 1;
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
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
    generate: vi.fn(async () => next()),
    generateStream: vi.fn(async () => next()),
    supportsStreaming: () => false,
  } as any;
}

const PLAN_JSON = JSON.stringify({
  goal: "add a health endpoint",
  planType: "coding",
  estimatedComplexity: "low",
  steps: [
    { id: "step_1", title: "Add the endpoint", description: "..." },
    { id: "step_2", title: "Write a test", description: "..." },
  ],
});

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
});

describe("CodingAgent planOnly", () => {
  it("creates and reports the plan without ever entering the attempt loop (no exploration needed)", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-plan-only-"));
    sandboxes.push(sandbox);
    // First response is consumed by the exploration sub-run - "Fertig." means it calls no tools
    // and finishes immediately (a trivial goal needs no investigation). Second is the Planner.
    const provider = scriptedProvider(["Fertig.", PLAN_JSON]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const innerAgent = (codingAgent as any).agent;
    const executeSpy = vi.spyOn(innerAgent.executor, "execute");

    const result = await codingAgent.run("add a health endpoint", { planOnly: true });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(0);
    expect(result.summary).toContain("Add the endpoint");
    expect(result.summary).toContain("Write a test");

    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(readdirSync(sandbox)).toHaveLength(0);

    const todos = (codingAgent as any).todos.snapshot();
    expect(todos).toHaveLength(2);
    expect(todos.every((t: { status: string }) => t.status === "pending")).toBe(true);
  });

  it("does not penalize the plan-only result for the plan's checklist being all-open", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-plan-only-checklist-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider(["Fertig.", PLAN_JSON]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("add a health endpoint", { planOnly: true });

    expect(result.success).toBe(true);
    expect(result.summary).not.toContain("Pflichtschritte");
    expect(result.summary).not.toContain("Incomplete");
  });

  it("lets the exploration sub-run read files and feeds its findings into the planner prompt", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-plan-only-explore-read-"));
    sandboxes.push(sandbox);
    writeFileSync(join(sandbox, "README.md"), "This project uses Express with routes under src/routes.");

    const provider = scriptedProvider([
      "[TOOL:filesystem action=read path=README.md]",
      "Investigation summary: Express project, routes live under src/routes.",
      PLAN_JSON,
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    await codingAgent.run("add a health endpoint", { planOnly: true });

    // The Planner is always the LAST generate() call - its prompt must carry the exploration's
    // final summary so the plan is actually grounded in what was found.
    const plannerCall = provider.generate.mock.calls.at(-1);
    const plannerPrompt = JSON.stringify(plannerCall?.[0]);
    expect(plannerPrompt).toContain("Investigation summary");
    expect(plannerPrompt).toContain("routes live under src/routes");

    // Nothing was ever written - only a read happened.
    expect(readdirSync(sandbox)).toEqual(["README.md"]);
  });

  it("refuses a write attempt during exploration and never touches the filesystem", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-plan-only-explore-write-"));
    sandboxes.push(sandbox);

    const provider = scriptedProvider([
      "[TOOL:filesystem action=write path=app.js]\nhack\n[/TOOL]",
      "Verstanden, ich aendere nichts.",
      PLAN_JSON,
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const innerAgent = (codingAgent as any).agent;
    const executeSpy = vi.spyOn(innerAgent.executor, "execute");

    const result = await codingAgent.run("add a health endpoint", { planOnly: true });

    expect(result.success).toBe(true);
    expect(readdirSync(sandbox)).toHaveLength(0);
    // The refusal happens in the beforeTool hook, before executor.execute is ever reached for
    // the write - the real filesystem tool must never run.
    const filesystemCalls = executeSpy.mock.calls.filter((c) => c[0] === "filesystem");
    expect(filesystemCalls).toHaveLength(0);
  });

  it("refuses non-read-only git actions and shell commands during exploration", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-plan-only-explore-git-shell-"));
    sandboxes.push(sandbox);

    const provider = scriptedProvider([
      "[TOOL:git action=commit message=x]",
      "[TOOL:shell command=\"npm install\"]",
      "Verstanden.",
      PLAN_JSON,
    ]);
    const codingAgent = new CodingAgent(provider, stubDb({ ENABLED_OPTIONAL_TOOLS: JSON.stringify(["git", "shell"]) }), undefined, {
      sandboxRoot: sandbox,
    });
    (codingAgent as any).agent.enablePlanning = false;

    const innerAgent = (codingAgent as any).agent;
    const executeSpy = vi.spyOn(innerAgent.executor, "execute");

    await codingAgent.run("add a health endpoint", { planOnly: true });

    // Neither the git commit nor the npm install ever reaches the real tool - either the
    // plan-only lock refuses it (its own beforeTool hook) or an earlier gate does. Either way,
    // what actually matters holds: the sandbox stays untouched.
    expect(executeSpy.mock.calls.filter((c) => c[0] === "git")).toHaveLength(0);
    expect(executeSpy.mock.calls.filter((c) => c[0] === "shell")).toHaveLength(0);
    expect(readdirSync(sandbox)).toHaveLength(0);
  });

  it("caps the exploration sub-run at PLAN_ONLY_EXPLORE_MAX_ITERATIONS tool calls", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-plan-only-explore-cap-"));
    sandboxes.push(sandbox);
    // 20 distinct, individually existing files so every read succeeds (no consecutive-failure
    // guardrail) and no two calls are identical (no stale-read-loop guardrail) - isolating the
    // Plan-Mode budget as the only thing that can cut this off early.
    const fileCount = 20;
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(sandbox, `file${i}.txt`), `content ${i}`);
    }
    const readCalls = Array.from({ length: fileCount }, (_, i) => `[TOOL:filesystem action=read path=file${i}.txt]`);
    const provider = scriptedProvider([...readCalls, "Fertig.", PLAN_JSON]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const innerAgent = (codingAgent as any).agent;
    const executeSpy = vi.spyOn(innerAgent.executor, "execute");

    await codingAgent.run("add a health endpoint", { planOnly: true });

    const readCallCount = executeSpy.mock.calls.filter(
      (c) => c[0] === "filesystem" && (c[1] as Record<string, unknown>)?.["action"] === "read"
    ).length;
    expect(readCallCount).toBeLessThan(fileCount);
    expect(readCallCount).toBeLessThanOrEqual(12);
  });
});
