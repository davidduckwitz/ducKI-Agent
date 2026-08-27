import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Import the BUILT output, not ../src - dist is what the server runs.
import { DatabaseService } from "../dist/index.js";

/**
 * Regression coverage for:
 *
 *   Failed to delete conversation 1244 for coding project …:
 *   LibsqlError: SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed
 *
 * Six tables carry a foreign key to `conversations.id`; deleteConversation cleared three. A
 * conversation that had ever executed a plan left `session_checklist` rows behind - and that
 * FK is NOT NULL, so SQLite refused the delete outright. Deleting a coding project therefore
 * removed its files but always left the chat.
 */
describe("deleteConversation", () => {
  let dir: string;
  let db: DatabaseService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ducki-delconv-test-"));
    db = new DatabaseService(join(dir, "test.db"));
    await db.initialize();
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can briefly hold the just-closed db file.
    }
  });

  it("deletes a plain conversation with its messages", async () => {
    const conv = await db.createConversation({ name: "[Coding] test" });
    await db.addMessage({ conversationId: conv.id, role: "user", content: "hallo" });

    await db.deleteConversation(conv.id);

    expect(await db.getConversation(conv.id)).toBeUndefined();
    expect(await db.getMessages(conv.id)).toHaveLength(0);
  });

  it("deletes a conversation that executed a plan (the reported failure)", async () => {
    const conv = await db.createConversation({ name: "[Coding] bitcoin-dashboard" });
    await db.addMessage({ conversationId: conv.id, role: "user", content: "baue das Dashboard" });
    await db.createChecklist(conv.id, "run-1", [
      { title: "Schritt 1" },
      { title: "Schritt 2" },
    ]);

    expect(await db.getChecklist(conv.id, "run-1")).toHaveLength(2);

    // Before the fix this threw SQLITE_CONSTRAINT_FOREIGNKEY.
    await expect(db.deleteConversation(conv.id)).resolves.toBeUndefined();

    expect(await db.getConversation(conv.id)).toBeUndefined();
    expect(await db.getChecklist(conv.id, "run-1")).toHaveLength(0);
  });

  it("keeps persisted plans and runs readable while unlinking a deleted conversation", async () => {
    const conv = await db.createConversation({ name: "[Coding] versioned plan" });
    const plan = await db.createPlan({
      conversationId: conv.id, projectId: null, goal: "Implement feature", title: "Feature",
      complexity: 3, steps: JSON.stringify([{ id: "step_1", title: "Implement", status: "pending" }]),
      tools: "[]", markdown: null, status: "active", version: 1, parentPlanId: null, repositorySnapshot: null,
    });
    await db.createPlanRun({
      id: "run-1", planId: plan.id, planVersion: 1, conversationId: conv.id, projectId: null,
      projectSlug: "feature", status: "running", attempt: 1, result: null, startedAt: new Date().toISOString(), finishedAt: null,
    });

    await expect(db.deleteConversation(conv.id)).resolves.toBeUndefined();

    expect((await db.getPlan(plan.id))?.conversationId).toBeNull();
    expect((await db.listPlanRuns(plan.id))[0]?.conversationId).toBeNull();
  });

  it("keeps a cron job alive and just unlinks it", async () => {
    // Deleting a user's scheduled job because the chat it was created in went away would be a
    // considerably worse bug than the one this fixes.
    const conv = await db.createConversation({ name: "[Coding] test" });
    const job = await db.createCronJob({
      name: "Taeglicher Bericht",
      schedule: "0 8 * * *",
      targetType: "prompt",
      targetRef: "Bericht erstellen",
      conversationId: conv.id,
    } as never);

    await db.deleteConversation(conv.id);

    const stillThere = await db.getCronJob((job as { id: number }).id);
    expect(stillThere, "the job must survive").toBeDefined();
    expect((stillThere as { conversationId: number | null }).conversationId).toBeNull();
  });

  it("is idempotent for an id that no longer exists", async () => {
    await expect(db.deleteConversation(999_999)).resolves.toBeUndefined();
  });
});
