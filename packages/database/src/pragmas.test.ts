import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseService } from "./index.ts";

/**
 * "database is locked" came from SQLite's defaults: rollback journal (a writer locks
 * out every reader) and no busy timeout (contention fails instantly).
 */
describe("DatabaseService connection pragmas", () => {
  let dir: string;
  let service: DatabaseService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ducki-db-"));
    service = new DatabaseService(join(dir, "test.db"));
    await service.initialize();
  });

  afterEach(() => {
    (service as unknown as { client?: { close?: () => void } }).client?.close?.();
    // Best-effort: Windows keeps the file handle briefly after close, and a failed
    // temp-dir cleanup must not be reported as a failing test.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The OS cleans up its own temp directory.
    }
  });

  /** SQLite does not always name the result column after the pragma - `busy_timeout`
   *  comes back as `timeout` - so read whatever single value the row carries. */
  const pragma = async (name: string): Promise<string> => {
    const client = (service as unknown as { client: { execute: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> } }).client;
    const result = await client.execute(`PRAGMA ${name}`);
    const row = result.rows[0];
    if (!row) return "";
    return String(row[name] ?? Object.values(row)[0] ?? "");
  };

  it("runs in WAL mode so readers do not block the writer", async () => {
    expect((await pragma("journal_mode")).toLowerCase()).toBe("wal");
  });

  it("waits on a contended lock instead of failing immediately", async () => {
    expect(Number(await pragma("busy_timeout"))).toBeGreaterThanOrEqual(5000);
  });

  it("uses the synchronous level documented as safe with WAL", async () => {
    // 1 = NORMAL
    expect(Number(await pragma("synchronous"))).toBe(1);
  });

  it("still writes and reads back normally", async () => {
    const conversation = await service.createConversation({ name: "pragma-test" });
    await service.addMessage({ conversationId: conversation.id, role: "user", content: "hello" });
    const messages = await service.getMessages(conversation.id);
    expect(messages.map((m) => m.content)).toContain("hello");
  });

  it("survives many interleaved writes without locking up", async () => {
    const conversation = await service.createConversation({ name: "concurrent" });
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        service.addMessage({ conversationId: conversation.id, role: "event", content: `event ${i}` })
      )
    );
    const messages = await service.getMessages(conversation.id);
    expect(messages.length).toBe(40);
  });
});
