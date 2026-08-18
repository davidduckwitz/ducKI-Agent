import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../src/index.js";

describe("conversations.pluginContext (fresh DB + migration)", () => {
  let dir: string;
  let db: DatabaseService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ducki-plugin-context-"));
    db = new DatabaseService(join(dir, "test.db"));
    await db.initialize();
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may keep a brief handle on the file; safe to ignore in tests.
    }
  });

  it("is null by default on a freshly created conversation", async () => {
    const conversation = await db.createConversation({ name: "test convo" });
    expect(conversation.pluginContext ?? null).toBeNull();
  });

  it("round-trips through updateConversation and getConversation", async () => {
    const created = await db.createConversation({ name: "plugin convo" });
    const updated = await db.updateConversation(created.id, { pluginContext: "my-plugin" });
    expect(updated?.pluginContext).toBe("my-plugin");

    const fetched = await db.getConversation(created.id);
    expect(fetched?.pluginContext).toBe("my-plugin");
  });

  it("is included in listConversations results", async () => {
    const created = await db.createConversation({ name: "plugin convo 2" });
    await db.updateConversation(created.id, { pluginContext: "another-plugin" });

    const list = await db.listConversations();
    const found = list.find((c) => c.id === created.id);
    expect(found?.pluginContext).toBe("another-plugin");
  });
});
