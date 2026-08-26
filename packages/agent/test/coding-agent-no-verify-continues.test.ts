import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * Regression for "the agent just stopped": a project with no detectable verifyCommand (no
 * package.json/tsconfig.json - e.g. a plain static HTML/JS project) used to accept the FIRST
 * attempt's result as final the moment the model's response contained no more tool calls, even
 * when the model's own checklist still had open steps (typically VERIFY/REPORT never reached).
 * CodingAgent.run() now checks the checklist before accepting an unverified result: open items
 * trigger one more bounded attempt instead of silently finalizing mid-checklist.
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
  goal: "build a static world clock page",
  estimatedComplexity: "low",
  steps: [
    { id: "step_1", title: "Write index.html", description: "..." },
    { id: "step_2", title: "Verify it works", description: "..." },
  ],
});

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
});

describe("CodingAgent continues when there's no verifyCommand and the checklist is unfinished", () => {
  it("does not loop on the same ungrounded step announcement or run date preflight for coding-time text", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-repeated-announcement-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      PLAN_JSON,
      "Step 2: Create main.js with a world-clock runtime",
      "Step 2: Create main.js with a world-clock runtime",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    expect((codingAgent as any).agent.isDateTimeIntent("Create a world clock that displays time")).toBe(false);
    expect((codingAgent as any).agent.isDateTimeIntent("What is the current time?")).toBe(true);

    const result = await codingAgent.run("Create a world clock that displays time", { maxAttempts: 3 });

    expect(result.attempts).toBe(2);
    expect(result.verified).toBe(false);
  }, 20000);

  it("continues an explicit EXPLORE-to-EDIT transition before the first file change", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-explore-edit-transition-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      PLAN_JSON,
      "Step 2: Create main.js with Phaser config and BootScene",
      "[TOOL:filesystem action=write path=main.js]\nconst game = {};\n[/TOOL]",
      '[TOOL:todo({"action":"write","items":[{"title":"Write index.html","status":"done"},{"title":"Verify it works","status":"done"}]})]',
      "Fertig.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("build a static world clock page", { maxAttempts: 3 });

    expect(result.attempts).toBe(2);
    expect(result.success).toBe(true);
    expect(result.summary).toContain("Fertig");
  }, 20000);

  it("reconciles an explicit next-step transition with the checklist and plan", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-step-reconcile-"));
    sandboxes.push(sandbox);
    const prompts: string[] = [];
    const scripted = [
      PLAN_JSON,
      "[TOOL:filesystem action=write path=index.html]\n<html></html>\n[/TOOL]",
      "Step 2: Verify it works",
      "[TOOL:todo action=update id=2 status=done]",
      "Fertig.",
    ];
    let index = 0;
    const provider = {
      model: "test-model",
      generate: async (messages: Array<{ role: string; content: string }>) => {
        prompts.push(
          messages
            .filter((message) => message.role === "user")
            .map((message) => message.content)
            .join("\n\n"),
        );
        return {
          content: scripted[Math.min(index++, scripted.length - 1)]!,
          model: "test-model",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop",
        };
      },
      supportsStreaming: () => false,
    } as any;
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("build a static world clock page", { maxAttempts: 3 });

    expect(result.attempts).toBe(2);
    const todos = (codingAgent as any).todos.snapshot();
    expect(todos.map((item: { status: string }) => item.status)).toEqual(["done", "done"]);
    expect((codingAgent as any).currentPlan.steps.map((step: { status: string }) => step.status)).toEqual([
      "completed",
      "completed",
    ]);
    const continuation = prompts.find((prompt) => prompt.includes("structured checklist steps were still open"));
    expect(continuation).toContain("[x] 1. Write index.html");
    expect(continuation).toContain("[~] 2. Verify it works");
    expect(continuation).not.toContain("did not pass verification");
  }, 20000);

  it("does not finalize while the checklist still has open steps", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-no-verify-"));
    sandboxes.push(sandbox);
    // No package.json/tsconfig.json in the sandbox -> detectDefaultVerifyCommand() returns
    // undefined, exactly the "static page, nothing to build/test" case that surfaced the bug.
    // Step 1 (Write index.html) genuinely writes a file; step 2 (Verify) legitimately does not -
    // there is nothing to edit in a verification, only something to check.
    const provider = scriptedProvider([
      PLAN_JSON,
      "[TOOL:filesystem action=write path=index.html]\n<html></html>\n[/TOOL]",
      '[TOOL:todo({"action":"write","items":[{"title":"Write index.html","status":"done"},{"title":"Verify it works"}]})]',
      "Fertig.",
      "[TOOL:todo action=update id=2 status=done]",
      "Fertig.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("build a static world clock page", { maxAttempts: 3 });

    expect(result.attempts).toBe(2);
    expect(result.success).toBe(true);
    expect(result.verified).toBe(false);
    const todos = (codingAgent as any).todos.snapshot();
    expect(todos.every((item: { status: string }) => item.status === "done")).toBe(true);
  });

  it("still finalizes on the first attempt when the checklist has no open steps", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-no-verify-done-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      PLAN_JSON,
      "[TOOL:filesystem action=write path=index.html]\n<html></html>\n[/TOOL]",
      '[TOOL:todo({"action":"write","items":[{"title":"Write index.html","status":"done"},{"title":"Verify it works","status":"done"}]})]',
      "Fertig.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("build a static world clock page", { maxAttempts: 3 });

    expect(result.attempts).toBe(1);
    expect(result.success).toBe(true);
    expect(result.verified).toBe(false);
  });
});
