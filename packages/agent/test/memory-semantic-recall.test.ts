import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseService } from "@ducki/database";
import { createLogger } from "@ducki/logger";
import { MemorySystem } from "../src/memory/memory.ts";

/**
 * getRelevantContext/buildDynamicContextWithKeywords used to hard-filter to type
 * "long-term", silently excluding "semantic" memories (e.g. LLM-wiki content
 * auto-learned as `[LLM-WIKI:...]` entries) from keyword-relevance retrieval - the
 * only path that ever surfaced them was buildSystemContext's top-8-by-importance
 * dump, which a semantic memory could easily lose out on. This caused the agent to
 * claim "I have no information" about topics it actually had semantic memories for.
 */
describe("keyword-relevance memory recall includes semantic memories when requested", () => {
  let dir: string;
  let db: DatabaseService;
  let mem: MemorySystem;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ducki-semantic-recall-"));
    db = new DatabaseService(join(dir, "mem.db"));
    await db.initialize();
    mem = new MemorySystem(db, createLogger({ module: "test" }));
    await db.addMemory({ type: "semantic", content: "[LLM-WIKI:health/chs.md] CHS is a condition linked to chronic cannabis use.", importance: 7 });
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

  it("getRelevantContext: defaults to long-term only (unchanged behavior for existing callers)", async () => {
    const result = await mem.getRelevantContext("cannabis CHS condition");
    expect(result).toEqual([]);
  });

  it("getRelevantContext: finds the semantic memory when semantic is requested", async () => {
    const result = await mem.getRelevantContext("cannabis CHS condition", 5, ["long-term", "semantic"]);
    expect(result.some((c) => c.includes("CHS"))).toBe(true);
  });

  it("getRelevantContext: still finds long-term memories when semantic is included", async () => {
    const result = await mem.getRelevantContext("dark mode editor preference", 5, ["long-term", "semantic"]);
    expect(result.some((c) => c.includes("dark mode"))).toBe(true);
  });

  it("buildDynamicContextWithKeywords: defaults to long-term only (unchanged behavior for existing callers)", async () => {
    const result = await mem.buildDynamicContextWithKeywords(["chs", "cannabis"]);
    expect(result).toBe("");
  });

  it("buildDynamicContextWithKeywords: finds the semantic memory when semantic is requested", async () => {
    const result = await mem.buildDynamicContextWithKeywords(["chs", "cannabis"], undefined, 6, ["long-term", "semantic"]);
    expect(result).toContain("CHS");
  });

  it("buildDynamicContextWithKeywords: round-robin merges across types instead of one crowding out the other", async () => {
    // Add enough long-term matches to exceed the limit on their own, to prove the
    // semantic hit isn't starved out by a full long-term pool.
    for (let i = 0; i < 10; i++) {
      await db.addMemory({ type: "long-term", content: `Preference note ${i} about cannabis-adjacent topic filler`, importance: 3 });
    }
    const result = await mem.buildDynamicContextWithKeywords(["cannabis"], undefined, 4, ["long-term", "semantic"]);
    expect(result).toContain("CHS");
  });
});
