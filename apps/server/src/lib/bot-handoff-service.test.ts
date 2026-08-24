import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseService } from "@ducki/database";
import { BotHandoffService } from "./bot-handoff-service";

/**
 * Integration tests for the bot handoff flow:
 *   "@botB übernimm X"  -> creates a task with source->target encoding
 *   "@botB erledigt"    -> marks task completed with result
 *   "@botB blockiert"   -> marks task blocked with reason
 */
describe("BotHandoffService", () => {
  let dir: string;
  let db: DatabaseService;
  let service: BotHandoffService;
  let convId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ducki-handoff-"));
    db = new DatabaseService(join(dir, "test.db"));
    await db.initialize();
    service = new BotHandoffService(db);

    // Handoffs write system messages into the conversation, which
    // requires a real conversation row (FK constraint).
    const conv = await db.createConversation({
      name: "Test Bot Chat",
      origin: "bot_chat",
    });
    convId = conv.id;
  });

  afterEach(() => {
    (db as unknown as { client?: { close?: () => void } }).client?.close?.();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* OS cleanup */ }
  });

  const PARTICIPANTS = ["researcher", "writer", "reviewer"];

  // ---- ENCODING ----

  it("encodes source and target in createdBy", async () => {
    const results = await service.processMessageForHandoffs(
      "@writer übernimm den Report schreiben",
      "researcher",
      convId,
      PARTICIPANTS
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("den Report schreiben");
    expect(results[0]!.assignedBy).toBe("researcher");
    expect(results[0]!.assignedTo).toBe("writer");
    expect(results[0]!.status).toBe("pending");

    // Verify the DB row encoding
    const task = await db.getTask(results[0]!.taskId);
    expect(task).toBeTruthy();
    expect(task!.createdBy).toBe("bot:researcher→writer");
  });

  it("skips handoff when target is not in participants", async () => {
    const results = await service.processMessageForHandoffs(
      "@outsider übernimm something",
      "researcher",
      convId,
      PARTICIPANTS
    );

    expect(results).toHaveLength(0);
  });

  // ---- DONE PATTERN ----

  it("marks a pending task completed via done pattern", async () => {
    const created = await service.processMessageForHandoffs(
      "@writer übernimm den Report",
      "researcher",
      convId,
      PARTICIPANTS
    );
    expect(created).toHaveLength(1);
    const taskId = created[0]!.taskId;

    const done = await service.processMessageForHandoffs(
      "@writer erledigt, Report liegt in output/report.md",
      "researcher",
      convId,
      PARTICIPANTS
    );

    expect(done).toHaveLength(1);
    expect(done[0]!.taskId).toBe(taskId);
    expect(done[0]!.status).toBe("completed");
    expect(done[0]!.result).toContain("output/report.md");

    const updated = await db.getTask(taskId);
    expect(updated).toBeTruthy();
    expect(updated!.status).toBe("completed");
  });

  it("done pattern without trailing text uses default result", async () => {
    await service.processMessageForHandoffs(
      "@writer übernimm den Test",
      "researcher",
      convId,
      PARTICIPANTS
    );

    const done = await service.processMessageForHandoffs(
      "@writer erledigt.",
      "researcher",
      convId,
      PARTICIPANTS
    );

    expect(done).toHaveLength(1);
    expect(done[0]!.status).toBe("completed");
    expect(done[0]!.result).toBe("Erledigt von @researcher");
  });

  it("done pattern matches 'ist erledigt' variant", async () => {
    await service.processMessageForHandoffs(
      "@writer übernimm den Test",
      "researcher",
      convId,
      PARTICIPANTS
    );

    const done = await service.processMessageForHandoffs(
      "@writer ist erledigt",
      "researcher",
      convId,
      PARTICIPANTS
    );

    expect(done).toHaveLength(1);
    expect(done[0]!.status).toBe("completed");
  });

  // ---- BLOCKED PATTERN ----

  it("marks a pending task blocked via blocked pattern", async () => {
    const created = await service.processMessageForHandoffs(
      "@writer übernimm den Report",
      "researcher",
      convId,
      PARTICIPANTS
    );
    const taskId = created[0]!.taskId;

    const blocked = await service.processMessageForHandoffs(
      "@writer blockiert durch fehlende API-Keys",
      "researcher",
      convId,
      PARTICIPANTS
    );

    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.taskId).toBe(taskId);
    expect(blocked[0]!.status).toBe("blocked");
    expect(blocked[0]!.result).toContain("fehlende API-Keys");
  });

  it("blocked pattern with English variant", async () => {
    await service.processMessageForHandoffs(
      "@writer take over the report",
      "researcher",
      convId,
      PARTICIPANTS
    );

    const blocked = await service.processMessageForHandoffs(
      "@writer blocked by missing credentials",
      "researcher",
      convId,
      PARTICIPANTS
    );

    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.status).toBe("blocked");
  });

  // ---- CROSS-BOT DONE ----

  it("done pattern works when a different bot signals completion", async () => {
    // researcher assigns to writer
    await service.processMessageForHandoffs(
      "@writer übernimm den Report",
      "researcher",
      convId,
      PARTICIPANTS
    );

    // reviewer (not the assigner) marks it done
    const done = await service.processMessageForHandoffs(
      "@writer erledigt",
      "reviewer",
      convId,
      PARTICIPANTS
    );

    expect(done).toHaveLength(1);
    expect(done[0]!.status).toBe("completed");
  });

  // ---- MULTIPLE TASKS FOR SAME TARGET ----

  it("done pattern completes the most recent pending task for the target (newest-first)", async () => {
    // Create two tasks for writer
    await service.processMessageForHandoffs(
      "@writer übernimm task A",
      "researcher",
      convId,
      PARTICIPANTS
    );
    await service.processMessageForHandoffs(
      "@writer übernimm task B",
      "researcher",
      convId,
      PARTICIPANTS
    );

    // Mark writer done - listTasks() returns DESC created_at, so the done
    // pattern finds the most recent pending task first (task B).
    const done = await service.processMessageForHandoffs(
      "@writer erledigt",
      "reviewer",
      convId,
      PARTICIPANTS
    );

    expect(done).toHaveLength(1);
    // The remaining open task is task A (older, not the one completed).
    const open = await service.getOpenHandoffs(convId);
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toBe("task A");
  });

  // ---- HANDOFF CONTEXT ----

  it("getHandoffContext returns formatted string with open tasks", async () => {
    await service.processMessageForHandoffs(
      "@writer übernimm den Report schreiben",
      "researcher",
      convId,
      PARTICIPANTS
    );

    const context = await service.getHandoffContext(convId);

    expect(context).toContain("=== Open Task Handoffs ===");
    expect(context).toContain("@researcher");
    expect(context).toContain("@writer");
    expect(context).toContain("den Report schreiben");
    expect(context).toContain("[pending]");
    expect(context).toContain("@botname done");
  });

  it("getHandoffContext returns empty string when no open handoffs", async () => {
    const context = await service.getHandoffContext(convId);
    expect(context).toBe("");
  });
});