import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseService } from "./index.ts";

/**
 * Phase 1 of the session-checklist feature: persistence only. These tests pin the
 * CRUD contract the checklist-manager (Phase 2) and run-loop (Phase 4) will build on.
 */
describe("DatabaseService session checklist", () => {
  let dir: string;
  let service: DatabaseService;
  let conversationId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ducki-checklist-"));
    service = new DatabaseService(join(dir, "test.db"));
    await service.initialize();
    const conv = await service.createConversation({ name: "checklist run" });
    conversationId = conv.id;
  });

  afterEach(() => {
    (service as unknown as { client?: { close?: () => void } }).client?.close?.();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The OS cleans up its own temp directory.
    }
  });

  it("creates a checklist with ordered step indices and pending defaults", async () => {
    const items = await service.createChecklist(conversationId, "run-1", [
      { title: "Recherchieren", acceptanceCriteria: "Quellen gesammelt", constraintKind: "requirement" },
      { title: "Zusammenfassen", description: "kurz halten" },
      { title: "Veröffentlichen" },
    ]);

    expect(items).toHaveLength(3);
    expect(items.map((i) => i.stepIndex)).toEqual([0, 1, 2]);
    expect(items.every((i) => i.status === "pending")).toBe(true);
    expect(items.every((i) => i.attempts === 0)).toBe(true);
    expect(items[0]?.acceptanceCriteria).toBe("Quellen gesammelt");
    expect(items[0]?.constraintKind).toBe("requirement");
    expect(items[1]?.description).toBe("kurz halten");
  });

  it("returns an empty array when creating with no items", async () => {
    const items = await service.createChecklist(conversationId, "run-1", []);
    expect(items).toEqual([]);
  });

  it("reads back the checklist ordered by step, scoped by runId", async () => {
    await service.createChecklist(conversationId, "run-1", [{ title: "A" }, { title: "B" }]);
    await service.createChecklist(conversationId, "run-2", [{ title: "C" }]);

    const run1 = await service.getChecklist(conversationId, "run-1");
    expect(run1.map((i) => i.title)).toEqual(["A", "B"]);

    const run2 = await service.getChecklist(conversationId, "run-2");
    expect(run2.map((i) => i.title)).toEqual(["C"]);

    const all = await service.getChecklist(conversationId);
    expect(all).toHaveLength(3);
  });

  it("filters open items and excludes resolved statuses", async () => {
    const items = await service.createChecklist(conversationId, "run-1", [
      { title: "A" },
      { title: "B" },
      { title: "C" },
    ]);
    await service.updateChecklistItem(items[0]!.id, { status: "done", confidence: "verified" });
    await service.updateChecklistItem(items[1]!.id, { status: "in_progress" });
    // C stays pending

    const open = await service.getOpenChecklistItems(conversationId, "run-1");
    expect(open.map((i) => i.title)).toEqual(["B", "C"]);
  });

  it("treats unverified/skipped/failed as resolved (not open)", async () => {
    const items = await service.createChecklist(conversationId, "run-1", [
      { title: "A" },
      { title: "B" },
      { title: "C" },
    ]);
    await service.updateChecklistItem(items[0]!.id, { status: "unverified", confidence: "soft" });
    await service.updateChecklistItem(items[1]!.id, { status: "skipped" });
    await service.updateChecklistItem(items[2]!.id, { status: "failed" });

    const open = await service.getOpenChecklistItems(conversationId, "run-1");
    expect(open).toHaveLength(0);
  });

  it("updates an item's status, attempts and verifyState, bumping updatedAt", async () => {
    const [item] = await service.createChecklist(conversationId, "run-1", [{ title: "A" }]);
    const before = item!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));

    const updated = await service.updateChecklistItem(item!.id, {
      status: "failed",
      attempts: 2,
      verifyState: JSON.stringify({ failures: ["missing X"] }),
    });

    expect(updated?.status).toBe("failed");
    expect(updated?.attempts).toBe(2);
    expect(updated?.verifyState).toContain("missing X");
    expect(updated?.updatedAt >= before).toBe(true);
  });

  it("deletes a single run without touching other runs", async () => {
    await service.createChecklist(conversationId, "run-1", [{ title: "A" }]);
    await service.createChecklist(conversationId, "run-2", [{ title: "B" }]);

    await service.deleteChecklist(conversationId, "run-1");

    expect(await service.getChecklist(conversationId, "run-1")).toHaveLength(0);
    expect(await service.getChecklist(conversationId, "run-2")).toHaveLength(1);
  });

  it("deletes the whole conversation's checklist when no runId is given", async () => {
    await service.createChecklist(conversationId, "run-1", [{ title: "A" }]);
    await service.createChecklist(conversationId, "run-2", [{ title: "B" }]);

    await service.deleteChecklist(conversationId);

    expect(await service.getChecklist(conversationId)).toHaveLength(0);
  });
});
