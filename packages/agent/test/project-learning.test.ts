import { describe, expect, it, vi } from "vitest";
import { ProjectLearning, type ProjectLesson } from "../src/coding/project-learning.js";
import { DatabaseService } from "@ducki/database";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const lesson = (projectId = "A", action = "Use pnpm"): ProjectLesson => ({ version: 1, projectId,
  trigger: "package manager", observation: "The repository uses pnpm", action,
  conditions: "When installing dependencies in this repository", verification: "pnpm test",
  evidence: ["pnpm test exited 0"], source: "coding-conversation:1", createdAt: new Date().toISOString() });
function database() {
  const rows: any[] = [];
  return { rows, getMemories: vi.fn(async (_id?: number, type?: string) => rows.filter(r => !type || r.type === type)),
    addMemory: vi.fn(async (data: any) => { const row = { ...data, id: rows.length + 1 }; rows.push(row); return row; }),
    updateMemoryStatus: vi.fn(async (id: number, status: string) => { const row = rows.find(r => r.id === id); row.status = status; return row; }),
  } as any;
}
describe("project learning", () => {
  it("persists approved project knowledge across a real database restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ducki-project-db-"));
    let db = new DatabaseService(join(root, "memory.db"));
    try {
      await db.initialize();
      const memory = new ProjectLearning(db, "A");
      await memory.remember(lesson());
      const saved = await db.getMemories(undefined, memory.type);
      await db.updateMemoryStatus(saved[0]!.id, "approved");
      db.close();
      db = new DatabaseService(join(root, "memory.db"));
      await db.initialize();
      expect(await new ProjectLearning(db, "A").recall("package manager")).toContain("Use pnpm");
      expect(await new ProjectLearning(db, "B").recall("package manager")).toBe("");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(error => {
        // libsql can hold its native mapping until the Windows worker exits. The fixture
        // is isolated in the OS temp directory; do not hide any other cleanup error.
        if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
      });
    }
  }, 20000);
  it("cancels bounded learning without persisting a result", async () => {
    const db = database();
    const memory = new ProjectLearning(db, "A");
    const controller = new AbortController();
    const provider = { generate: vi.fn(() => new Promise(() => {})) } as any;
    const pending = memory.learnVerifiedRun(provider, { goal: "fix", summary: "done", verifyCommand: "pnpm test",
      changedFiles: ["a.ts"], evidence: ["test passed"], success: true, verified: true, signal: controller.signal });
    controller.abort();
    expect(await pending).toBe(false);
    expect(db.addMemory).not.toHaveBeenCalled();
  });
  it("keeps generated lessons pending and isolates projects on recall", async () => {
    const db = database();
    const a = new ProjectLearning(db, "A");
    await a.remember(lesson());
    expect(await a.recall("package manager")).toBe("");
    await db.updateMemoryStatus(1, "approved");
    expect(await new ProjectLearning(db, "A").recall("package manager")).toContain("pnpm");
    expect(await new ProjectLearning(db, "B").recall("package manager")).toBe("");
    await expect(a.remember(lesson("B"))).rejects.toThrow("Project mismatch");
  });
  it("does not replay a contradicted lesson once its replacement is approved", async () => {
    const db = database();
    const memory = new ProjectLearning(db, "A");
    await memory.remember(lesson());
    await db.updateMemoryStatus(1, "approved");
    await memory.remember({ ...lesson("A", "Use yarn"), observation: "The project migrated to yarn" });
    expect(await memory.recall("package manager")).toContain("Use pnpm");
    await db.updateMemoryStatus(2, "approved");
    const recalled = await memory.recall("package manager");
    expect(recalled).toContain("Use yarn");
    expect(recalled).not.toContain("Use pnpm");
    expect(await memory.consolidate()).toBe(1);
    expect(db.rows[0].status).toBe("superseded");
  });
  it("deduplicates and fails honestly when storage cannot be read back", async () => {
    const db = database();
    const memory = new ProjectLearning(db, "A");
    expect(await memory.remember(lesson())).toBe(true);
    expect(await memory.remember(lesson())).toBe(false);
    db.addMemory.mockResolvedValue({ id: 999 });
    await expect(memory.remember(lesson("A", "different evidence"))).rejects.toThrow("read back");
  });
  it("does not infer success from a tool call, failed run, or unverified completion", async () => {
    const provider = { generate: vi.fn() } as any;
    const memory = new ProjectLearning(database(), "A");
    for (const flags of [{ success: false, verified: true }, { success: true, verified: false }]) {
      expect(await memory.learnVerifiedRun(provider, { ...flags, goal: "fix", summary: "done", verifyCommand: "test",
        changedFiles: ["a.ts"], evidence: ["write succeeded"] })).toBe(false);
    }
    expect(provider.generate).not.toHaveBeenCalled();
  });
  it("only stores supported bounded candidates from verified runs", async () => {
    const db = database();
    const provider = { generate: vi.fn(async () => ({ content: JSON.stringify(lesson()) })) } as any;
    const memory = new ProjectLearning(db, "A");
    expect(await memory.learnVerifiedRun(provider, { success: true, verified: true, goal: "package manager", summary: "fixed", verifyCommand: "pnpm test",
      changedFiles: ["a.ts"], evidence: ["pnpm test exited 0"] })).toBe(true);
    expect(db.rows[0].status).toBe("pending");
    expect(JSON.parse(db.rows[0].content).verification).toBe("pnpm test");
  });
});
