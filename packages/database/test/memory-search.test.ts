import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Import the BUILT output, not ../src: a stale in-src schema.js (a leftover build artifact) would
// otherwise shadow schema.ts and hide the content_folded column. dist is what the server runs anyway.
import { DatabaseService } from "../dist/index.js";

describe("memory search prefilter + pruning", () => {
  let dir: string;
  let db: DatabaseService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ducki-mem-test-"));
    db = new DatabaseService(join(dir, "mem.db"));
    await db.initialize();
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can briefly hold the just-closed db file; leaving a temp file behind is harmless.
    }
  });

  // ── Folded prefilter is a superset: German umlauts must not drop rows ────────

  it("finds an umlaut memory via a folded keyword (prefilter does not drop it)", async () => {
    await db.addMemory({ content: "Plan zur Ausführung des Coding-Agenten", importance: 5, type: "long-term" });
    await db.addMemory({ content: "Completely unrelated banana note", importance: 5, type: "long-term" });

    // "ausfuehrung" is foldGerman("Ausführung"); the folded LIKE prefilter must keep the umlaut row.
    const hits = await db.searchMemories(["ausfuehrung"], undefined, "long-term", "approved", 10);
    expect(hits.map((h) => h.content)).toContain("Plan zur Ausführung des Coding-Agenten");
  });

  it("still excludes non-matching rows (prefilter is a superset, not a widener of results)", async () => {
    await db.addMemory({ content: "Plan zur Ausführung des Coding-Agenten", importance: 5, type: "long-term" });
    await db.addMemory({ content: "Completely unrelated banana note", importance: 5, type: "long-term" });

    const hits = await db.searchMemories(["ausfuehrung"], undefined, "long-term", "approved", 10);
    expect(hits.map((h) => h.content)).not.toContain("Completely unrelated banana note");
  });

  it("matches German compounds by prefix (memory -> memorysystem)", async () => {
    await db.addMemory({ content: "The MemorySystem handles recall", importance: 5, type: "long-term" });
    const hits = await db.searchMemories(["memory"], undefined, "long-term", "approved", 10);
    expect(hits).toHaveLength(1);
  });

  // ── Short-term pruning keeps only the newest rows ────────────────────────────

  it("prunes short-term memories down to the requested cap, keeping the newest", async () => {
    for (let i = 1; i <= 5; i++) {
      await db.addMemory({ content: `short note ${i}`, importance: 1, type: "short-term" });
    }
    const removed = await db.pruneShortTermMemories(2);
    expect(removed).toBe(3);

    const remaining = await db.getMemories(undefined, "short-term");
    expect(remaining).toHaveLength(2);
    // The two newest (highest ids) survive.
    expect(remaining.map((m) => m.content).sort()).toEqual(["short note 4", "short note 5"]);
  });

  it("keep=0 deletes ALL short-term but never touches long-term", async () => {
    await db.addMemory({ content: "durable fact", importance: 8, type: "long-term" });
    for (let i = 0; i < 3; i++) {
      await db.addMemory({ content: `ephemeral ${i}`, importance: 1, type: "short-term" });
    }

    const removed = await db.pruneShortTermMemories(0);
    expect(removed).toBe(3);

    // Regression guard: .limit(0) used to be treated as "no limit", so keep=0 removed nothing.
    expect(await db.getMemories(undefined, "short-term")).toHaveLength(0);
    expect(await db.getMemories(undefined, "long-term")).toHaveLength(1);
  });
});
