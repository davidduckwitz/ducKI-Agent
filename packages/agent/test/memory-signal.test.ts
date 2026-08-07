import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseService } from "@ducki/database";
import { createLogger } from "@ducki/logger";
import { MemorySystem } from "../src/memory/memory.ts";

describe("durable-learning signal gate (#4)", () => {
  let dir: string;
  let db: DatabaseService;
  let mem: MemorySystem;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ducki-signal-test-"));
    db = new DatabaseService(join(dir, "mem.db"));
    await db.initialize();
    mem = new MemorySystem(db, createLogger({ module: "test" }));
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold the just-closed db file.
    }
  });

  it("drops pure process telemetry (reflection scaffolding with no substance)", async () => {
    const stored = await mem.addDurableLearningIfNovel(
      "Self-Reflection Learning | Quality: good | Issues: - | Improvements: -",
      5
    );
    expect(stored).toBe(false);
    expect(await db.getMemories(undefined, "long-term")).toHaveLength(0);
  });

  it("keeps a learning that carries real substance", async () => {
    const stored = await mem.addDurableLearningIfNovel(
      "User prefers TypeScript strict mode and a dark editor theme with two-space indentation",
      6
    );
    expect(stored).toBe(true);
    expect(await db.getMemories(undefined, "long-term")).toHaveLength(1);
  });

  it("keeps a reflection that contains an actionable, content-bearing suggestion", async () => {
    const stored = await mem.addDurableLearningIfNovel(
      "Self-Reflection Learning | Quality: fair | Improvements: verify database migrations before deploying and add rollback steps",
      5
    );
    expect(stored).toBe(true);
  });
});
