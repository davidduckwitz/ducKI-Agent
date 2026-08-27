import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * A live browser session (the agent's own, or one the user started that the agent only
 * observes) goes stale the moment CodingAgent writes a file the page depends on - see
 * "coding-browser-staleness-tracker" in coding-agent.ts and reloadIfDirty in
 * packages/tools/src/browser.ts. This pins the CodingAgent side: a successful filesystem
 * write/edit/append must call browser:mark_dirty; anything else must not.
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
  goal: "add a health endpoint",
  planType: "coding",
  estimatedComplexity: "low",
  steps: [{ id: "step_1", title: "Add the endpoint", description: "..." }],
});

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
  vi.restoreAllMocks();
});

describe("CodingAgent marks the browser session dirty after its own edits", () => {
  it("calls browser:mark_dirty right after a successful filesystem write", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-browser-dirty-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      PLAN_JSON,
      "[TOOL:filesystem action=write path=app.js]\ncontent\n[/TOOL]",
      "[TOOL:todo action=update id=1 status=done]",
      "Fertig.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const innerAgent = (codingAgent as any).agent;
    const seenCalls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const originalExecute = innerAgent.executor.execute.bind(innerAgent.executor);
    innerAgent.executor.execute = vi.fn(async (toolName: string, input: Record<string, unknown>, opts?: unknown) => {
      const result = await originalExecute(toolName, input, opts);
      seenCalls.push({ toolName, input });
      return result;
    });

    await codingAgent.run("add a health endpoint", { maxAttempts: 1 });

    const writeIndex = seenCalls.findIndex((c) => c.toolName === "filesystem" && c.input["action"] === "write");
    const markDirtyIndex = seenCalls.findIndex((c) => c.toolName === "browser" && c.input["action"] === "mark_dirty");
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(markDirtyIndex).toBeGreaterThan(writeIndex);
  });

  it("does not call browser:mark_dirty when no file was ever written", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-browser-dirty-none-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([PLAN_JSON, "[TOOL:todo action=update id=1 status=done]", "Fertig."]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const innerAgent = (codingAgent as any).agent;
    const seenCalls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const originalExecute = innerAgent.executor.execute.bind(innerAgent.executor);
    innerAgent.executor.execute = vi.fn(async (toolName: string, input: Record<string, unknown>, opts?: unknown) => {
      const result = await originalExecute(toolName, input, opts);
      seenCalls.push({ toolName, input });
      return result;
    });

    await codingAgent.run("add a health endpoint", { maxAttempts: 1 });

    const markDirtyIndex = seenCalls.findIndex((c) => c.toolName === "browser" && c.input["action"] === "mark_dirty");
    expect(markDirtyIndex).toBe(-1);
  });
});
