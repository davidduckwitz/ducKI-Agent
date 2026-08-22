import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * The checklist is otherwise entirely self-reported: the model calls todo:update(done) and
 * nothing checks whether it actually wrote anything. This pins the grounding check added to
 * CodingAgent.run() - a step marked "done" in an attempt whose checkpoint diff shows zero
 * changed files must be demoted back to "in_progress" rather than trusted at face value.
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
  estimatedComplexity: "low",
  steps: [{ id: "step_1", title: "Add the endpoint", description: "..." }],
});

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
});

describe("CodingAgent checklist grounding against the checkpoint diff", () => {
  it("demotes a step marked done when the attempt changed no files", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-cp-ground-"));
    sandboxes.push(sandbox);
    // Marks the only step "done" without ever calling the filesystem tool.
    const provider = scriptedProvider([PLAN_JSON, "[TOOL:todo action=update id=1 status=done]", "Fertig."]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    await codingAgent.run("add a health endpoint", { maxAttempts: 1 });

    const todos = (codingAgent as any).todos.snapshot();
    expect(todos).toHaveLength(1);
    expect(todos[0].status).toBe("in_progress");
    expect(todos[0].note).toContain("Checkpoint-Diff");
  });

  it("keeps a step marked done when the attempt actually wrote a file", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-cp-ground-ok-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      PLAN_JSON,
      "[TOOL:filesystem action=write path=app.js]\ncontent\n[/TOOL]",
      "[TOOL:todo action=update id=1 status=done]",
      "Fertig.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    await codingAgent.run("add a health endpoint", { maxAttempts: 1 });

    const todos = (codingAgent as any).todos.snapshot();
    expect(todos).toHaveLength(1);
    expect(todos[0].status).toBe("done");
  });
});
