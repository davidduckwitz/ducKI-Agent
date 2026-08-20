import { describe, expect, it } from "vitest";
import { buildToolResultDedupeKey } from "../src/agent.ts";
import { condenseVerifyOutput } from "../src/coding/coding-agent.ts";
import { TodoList } from "../src/coding/todo-tool.ts";

describe("tool result dedupe keys", () => {
  it("keys read-only filesystem calls so a repeat collapses onto the newest", () => {
    const first = buildToolResultDedupeKey("filesystem", { action: "read", path: "src/a.ts" });
    const second = buildToolResultDedupeKey("filesystem", { path: "src/a.ts", action: "read" });
    expect(first).toBeDefined();
    // Key order in the call must not matter - the same read written two ways is one read.
    expect(second).toBe(first);
  });

  it("treats different regions of the same file as different results", () => {
    const head = buildToolResultDedupeKey("filesystem", { action: "read", path: "src/a.ts", offset: 0 });
    const tail = buildToolResultDedupeKey("filesystem", { action: "read", path: "src/a.ts", offset: 500 });
    expect(head).not.toBe(tail);
  });

  it("never dedupes actions that change something", () => {
    expect(buildToolResultDedupeKey("filesystem", { action: "write", path: "a.ts" })).toBeUndefined();
    expect(buildToolResultDedupeKey("filesystem", { action: "edit", path: "a.ts" })).toBeUndefined();
    expect(buildToolResultDedupeKey("shell", { command: "npm test" })).toBeUndefined();
    expect(buildToolResultDedupeKey("http", { url: "https://example.com" })).toBeUndefined();
  });

  it("covers the read-only git and diagnostics calls", () => {
    expect(buildToolResultDedupeKey("git", { action: "status" })).toBeDefined();
    expect(buildToolResultDedupeKey("git", { action: "commit", message: "x" })).toBeUndefined();
    expect(buildToolResultDedupeKey("diagnostics", { files: ["a.ts"] })).toBeDefined();
  });
});

describe("condenseVerifyOutput", () => {
  it("returns short output untouched", () => {
    expect(condenseVerifyOutput("all good")).toBe("all good");
  });

  it("keeps the diagnostic lines and drops the surrounding noise", () => {
    const noise = Array.from({ length: 400 }, (_, i) => `[build] processing module ${i}`).join("\n");
    const output = `${noise}\nsrc/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n${noise}\nDone in 4.2s`;

    const condensed = condenseVerifyOutput(output, 2000);

    expect(condensed).toContain("error TS2322");
    expect(condensed).toContain("src/app.ts(12,5)");
    // The point of the exercise: the 3.5KB of progress spam a head/tail cut would have kept
    // is gone, and the result fits the budget.
    expect(condensed.length).toBeLessThanOrEqual(2200);
    // 800 noise lines in, a handful out: one line of context around the error plus the
    // last few lines, which is where a runner prints its summary.
    expect(condensed.split("\n").filter((l) => l.includes("processing module")).length).toBeLessThan(10);
    expect(condensed).toContain("Done in 4.2s");
  });

  it("falls back to head/tail when nothing looks like a diagnostic", () => {
    const output = "x".repeat(9000);
    const condensed = condenseVerifyOutput(output, 1000);
    expect(condensed).toContain("gekuerzt");
  });
});

describe("TodoList", () => {
  it("replaces the list and reports progress", () => {
    const seen: number[] = [];
    const list = new TodoList((items) => seen.push(items.length));

    list.replace([{ title: "Read the router" }, { title: "Add the route" }]);
    expect(list.openCount).toBe(2);

    const items = list.snapshot();
    list.update(items[0]!.id, "done");
    expect(list.openCount).toBe(1);
    expect(list.render()).toContain("[x] 1. Read the router");
    expect(list.render()).toContain("[ ] 2. Add the route");
    expect(seen).toEqual([2, 2]);
  });

  it("rejects an unknown step id", () => {
    const list = new TodoList();
    list.replace([{ title: "One" }]);
    expect(list.update(99, "done")).toBeUndefined();
  });

  it("resets between runs", () => {
    const list = new TodoList();
    list.replace([{ title: "One" }]);
    list.reset();
    expect(list.snapshot()).toEqual([]);
    expect(list.render()).toBe("");
  });
});

describe("read-before-edit discipline", () => {
  it("refuses once and then lets the model through", async () => {
    // An unbounded refusal is a deadlock: each refusal counts as a failed tool call, so a model
    // that does not act on the instruction burns the whole consecutive-failure budget without
    // ever attempting an edit. The per-attempt checkpoint is the real safety net.
    const { CodingAgent } = await import("../src/coding/coding-agent.ts");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const sandbox = mkdtempSync(join(tmpdir(), "ducki-discipline-"));
    writeFileSync(join(sandbox, "existing.md"), "# already here");

    const db = new Proxy(
      {
        getAllSettings: async () => [],
        getDynamicToolByName: async () => undefined,
        getSetting: async () => undefined,
        createConversation: async () => ({ id: 1, name: "x" }),
      } as Record<string, (...args: any[]) => any>,
      { get: (t, p: string) => (p in t ? t[p] : async () => undefined) }
    ) as any;
    const provider = {
      model: "test-model",
      generate: async () => ({ content: "ok", model: "m", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
      generateStream: async () => ({ content: "ok", model: "m", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
      supportsStreaming: () => false,
    } as any;

    const agent = new CodingAgent(provider, db, undefined, { sandboxRoot: sandbox });
    const hook = (agent as any).agent.hookRegistry.executeHooks.bind((agent as any).agent.hookRegistry);
    const call = () => hook("beforeTool", { toolName: "filesystem", input: { action: "write", path: "existing.md", content: "x" } });

    const first = await call();
    expect(first.proceed).toBe(false);
    expect(first.reason).toContain("already exists");

    const second = await call();
    expect(second.proceed, "a repeated call must not deadlock the run").toBe(true);
  });

  it("does not refuse a file that was read first", async () => {
    const { CodingAgent } = await import("../src/coding/coding-agent.ts");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const sandbox = mkdtempSync(join(tmpdir(), "ducki-discipline2-"));
    writeFileSync(join(sandbox, "existing.md"), "# already here");

    const db = new Proxy(
      {
        getAllSettings: async () => [],
        getDynamicToolByName: async () => undefined,
        getSetting: async () => undefined,
      } as Record<string, (...args: any[]) => any>,
      { get: (t, p: string) => (p in t ? t[p] : async () => undefined) }
    ) as any;
    const provider = {
      model: "test-model",
      generate: async () => ({ content: "ok", model: "m", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
      generateStream: async () => ({ content: "ok", model: "m", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
      supportsStreaming: () => false,
    } as any;

    const agent = new CodingAgent(provider, db, undefined, { sandboxRoot: sandbox });
    const hook = (agent as any).agent.hookRegistry.executeHooks.bind((agent as any).agent.hookRegistry);

    await hook("beforeTool", { toolName: "filesystem", input: { action: "read", path: "existing.md" } });
    // Spelled differently on purpose - the same file, so the read must still count.
    const edit = await hook("beforeTool", { toolName: "filesystem", input: { action: "edit", path: "./existing.md", oldString: "a", newString: "b" } });
    expect(edit.proceed).toBe(true);
  });
});
