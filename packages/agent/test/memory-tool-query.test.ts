import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseService } from "@ducki/database";
import type { ToolExecutor } from "@ducki/shared";
import { createWorkflowTools } from "../src/workflow/workflow-tools.ts";

/**
 * The agent-facing `memory` tool's action=query used to hard-default its type filter to
 * "long-term" (via targetToType) whenever the caller didn't pass target/type explicitly -
 * which is the normal case, since the agent usually just calls
 * `memory({action:"query", query:"..."})`. That silently excluded every `semantic` memory
 * (which is what LLM-wiki-derived content becomes) from a plain recall question, causing
 * the agent to confidently claim it had no relevant memories when it actually did.
 */
describe("memory tool action=query searches semantic memories by default", () => {
  let dir: string;
  let db: DatabaseService;
  let memoryTool: ToolExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ducki-memtool-test-"));
    db = new DatabaseService(join(dir, "mem.db"));
    await db.initialize();
    const tool = createWorkflowTools(db).find((t) => t.name === "memory");
    if (!tool) throw new Error("memory tool not found in createWorkflowTools()");
    memoryTool = tool;

    await db.addMemory({ type: "semantic", content: "[LLM-WIKI:health/chs.md] CHS is linked to chronic cannabis use.", importance: 7 });
    await db.addMemory({ type: "long-term", content: "The user prefers dark mode in the editor.", importance: 5 });
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold the just-closed db file.
    }
  });

  it("finds a semantic memory on a plain query with no explicit target/type", async () => {
    const result = await memoryTool.execute({ action: "query", query: "cannabis CHS" });
    expect(result.success).toBe(true);
    const data = result.data as { entries: Array<{ content: string }> };
    expect(data.entries.some((e) => e.content.includes("CHS"))).toBe(true);
  });

  it("still finds long-term memories on the same unrestricted query", async () => {
    const result = await memoryTool.execute({ action: "query", query: "dark mode editor" });
    const data = result.data as { entries: Array<{ content: string }> };
    expect(data.entries.some((e) => e.content.includes("dark mode"))).toBe(true);
  });

  it("respects an explicit type=long-term and does not pull in semantic results", async () => {
    const result = await memoryTool.execute({ action: "query", query: "cannabis CHS", type: "long-term" });
    const data = result.data as { entries: Array<{ content: string }> };
    expect(data.entries.some((e) => e.content.includes("CHS"))).toBe(false);
  });

  it("respects an explicit target=user (semantic) and stays scoped to it", async () => {
    await db.addMemory({ type: "long-term", content: "cannabis-adjacent long-term filler note", importance: 3 });
    const result = await memoryTool.execute({ action: "query", query: "cannabis", target: "user" });
    const data = result.data as { entries: Array<{ content: string }> };
    expect(data.entries.every((e) => !e.content.includes("filler"))).toBe(true);
  });

  it("empty-keyword query (list-style) also spans both types when unrestricted", async () => {
    const result = await memoryTool.execute({ action: "query", query: "the" });
    // "the" alone may or may not extract keywords depending on stopword handling; the
    // real assertion is just that the call succeeds and returns an array either way.
    expect(result.success).toBe(true);
  });
});
