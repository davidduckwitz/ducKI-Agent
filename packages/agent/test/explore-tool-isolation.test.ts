import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExploreTool } from "../src/coding/explore-tool";
import { Agent } from "../src/agent";
import { TokenCounter } from "../src/context/token-counter";

function stubDb() {
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
    createConversation: async () => ({ id: 1, name: "x" }),
    getMessages: async () => [],
  };
  return new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as any;
}

function stubProvider() {
  return {
    model: "test-model",
    generate: async () => ({ content: "found it in src/a.ts:12", model: "test-model", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
    generateStream: async () => ({ content: "found it", model: "test-model", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
    supportsStreaming: () => false,
  } as any;
}

/**
 * The explore tool is documented and prompted as READ-ONLY. That promise is only worth
 * something if the sub-agent physically cannot do anything else - and the Agent constructor
 * auto-registers a pile of tools that very much can, including `gateway` (sends outbound
 * Discord/Telegram messages) and the script tools (execute code).
 */
describe("explore sub-agent isolation", () => {
  it("loads a custom profile for each disposable run without granting extra tools", async () => {
    const resolveProfile = vi.fn(async () => ({
      provider: stubProvider(),
      systemPrompt: "Prefer package boundaries.",
      allowedSkillSlugs: ["coding-system"],
    }));
    const seenToolSets: string[][] = [];
    const spy = vi.spyOn(Agent.prototype, "run").mockImplementation(async function (this: Agent) {
      seenToolSets.push(this.executor.listTools().map((tool) => tool.name).sort());
      return { response: "answer", iterations: 1, toolsUsed: [] } as any;
    });

    try {
      const tool = createExploreTool(stubProvider(), stubDb(), { resolveProfile });
      await tool.execute({ question: "where is the router?" });
    } finally {
      spy.mockRestore();
    }

    expect(resolveProfile).toHaveBeenCalledOnce();
    expect(seenToolSets[0]).toEqual(["filesystem", "submit_solution"]);
  });

  it("holds only filesystem and the completion tool", async () => {
    const seenToolSets: string[][] = [];
    const realRun = Agent.prototype.run;
    const spy = vi.spyOn(Agent.prototype, "run").mockImplementation(async function (this: Agent, ...args: any[]) {
      seenToolSets.push(this.executor.listTools().map((t) => t.name).sort());
      return { response: "answer", iterations: 1, toolsUsed: [] } as any;
    });

    try {
      const tool = createExploreTool(stubProvider(), stubDb(), {});
      await tool.execute({ question: "where is the router?" });
    } finally {
      spy.mockRestore();
      expect(Agent.prototype.run).toBe(realRun);
    }

    expect(seenToolSets).toHaveLength(1);
    expect(seenToolSets[0]).toEqual(["filesystem", "submit_solution"]);
  });

  it("rejects every writing filesystem action", async () => {
    const captured: any[] = [];
    const spy = vi.spyOn(Agent.prototype, "run").mockImplementation(async function (this: Agent) {
      captured.push(this.executor.getTool("filesystem"));
      return { response: "answer", iterations: 1, toolsUsed: [] } as any;
    });

    try {
      const tool = createExploreTool(stubProvider(), stubDb(), {});
      await tool.execute({ question: "where is the router?" });
    } finally {
      spy.mockRestore();
    }

    const fs = captured[0]!;
    for (const action of ["write", "edit", "append", "delete", "move", "mkdir", "copy"]) {
      const result = await fs.execute({ action, path: "a.ts", content: "x" });
      expect(result.success, `${action} must be refused`).toBe(false);
      expect(result.error).toContain("read-only");
    }
  });
});

/** Provider whose generate() never settles - simulates a hung local model endpoint. */
function neverResolvingProvider() {
  return {
    model: "test-model",
    generate: () => new Promise(() => {}),
    generateStream: () => new Promise(() => {}),
    supportsStreaming: () => false,
  } as any;
}

/** Provider handing back a scripted sequence of responses, one per generate call. */
function scriptedProvider(contents: string[]) {
  let index = 0;
  return {
    model: "test-model",
    generate: async () => {
      const content = contents[Math.min(index, contents.length - 1)] ?? "done";
      index++;
      return { content, model: "test-model", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
    generateStream: async () => ({
      content: "done",
      model: "test-model",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }),
    supportsStreaming: () => false,
  } as any;
}

describe("explore sub-agent hang protection", () => {
  it("aborts an exploration whose LLM call never settles, bounded by the timeout", async () => {
    const tool = createExploreTool(neverResolvingProvider(), stubDb(), { timeoutMs: 50 });
    const start = Date.now();
    const result = await tool.execute({ question: "where is the router?" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out after");
    expect(result.error).toContain("grep/glob");
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("reports a loop (repeated identical reads) as a failure instead of an answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "explore-loop-"));
    try {
      writeFileSync(join(dir, "a.txt"), "hello");
      const reads = Array(8).fill('[TOOL:filesystem({"action":"read","path":"a.txt"})]');
      const tool = createExploreTool(scriptedProvider([...reads, "done"]), stubDb(), {
        sandboxRoot: dir,
        timeoutMs: 30000,
      });

      const result = await tool.execute({ question: "what is in a.txt?" });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/without progress|loop detected/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still returns a normal answer for a productive one-shot exploration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "explore-ok-"));
    try {
      writeFileSync(join(dir, "a.txt"), "hello");
      const tool = createExploreTool(
        scriptedProvider(['[TOOL:filesystem({"action":"read","path":"a.txt"})]', "found it in a.txt:1"]),
        stubDb(),
        { sandboxRoot: dir, timeoutMs: 30000 }
      );

      const result = await tool.execute({ question: "what is in a.txt?" });

      expect(result.success).toBe(true);
      expect((result.data as any)?.answer).toContain("found it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * getModelConfig falls back to the 4096-token `local` entry for anything it does not
 * recognise. That is fine for a cost estimate and catastrophic for a context budget, so the
 * budget path asks findModelConfig instead - which must answer honestly.
 */
describe("TokenCounter.findModelConfig", () => {
  it("does not invent a config for unknown models", () => {
    for (const model of ["qwen2.5-coder:32b", "llama3.3:70b", "deepseek-chat", "mistral-small", ""]) {
      expect(TokenCounter.findModelConfig(model), model).toBeUndefined();
    }
  });

  it("resolves provider-prefixed and suffixed names to the right entry", () => {
    expect(TokenCounter.findModelConfig("anthropic/claude-sonnet-5")?.maxTokens).toBe(1_000_000);
    expect(TokenCounter.findModelConfig("gpt-4o-mini")?.maxTokens).toBe(TokenCounter.getModelConfig("gpt-4o").maxTokens);
  });

  it("still gives getModelConfig its local fallback for cost estimation", () => {
    expect(TokenCounter.getModelConfig("something-unheard-of").maxTokens).toBe(4096);
  });
});
