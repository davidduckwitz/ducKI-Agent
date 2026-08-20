import express from "express";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codingRouter, CODING_ROOT } from "./coding.js";

/**
 * Deleting a coding project removes real files and real chat history and cannot be undone, so
 * the guards around it are worth pinning down: it must take the project's OWN chat and nothing
 * else, and it must refuse anything that does not name exactly one project.
 */

interface Conversation {
  id: number;
  name: string;
}

function mockDb(conversations: Conversation[]) {
  const rows = new Map(conversations.map((c) => [c.id, { ...c }]));
  const messages = new Map<number, unknown[]>();
  for (const c of conversations) messages.set(c.id, [{ role: "user" }, { role: "assistant" }]);

  return {
    rows,
    db: {
      getSetting: async (key: string) => (key === "CODING_ENABLED" ? "true" : undefined),
      listConversations: async () => [...rows.values()],
      getConversation: async (id: number) => rows.get(id),
      getMessages: async (id: number) => messages.get(id) ?? [],
      deleteConversation: async (id: number) => {
        rows.delete(id);
        messages.delete(id);
      },
    },
  };
}

const openServers: Server[] = [];

async function startTestServer(db: unknown): Promise<string> {
  const app = express();
  app.use(express.json());
  app.locals["db"] = db;
  app.use("/api/coding", codingRouter);

  const server = createServer(app);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  return `http://127.0.0.1:${address.port}/api/coding`;
}

describe("DELETE /coding/projects/:project", () => {
  let slug: string;
  let projectDir: string;

  beforeEach(() => {
    // A uniquely named directory under the real coding root: that root is a module constant,
    // and the operation under test is precisely "remove a directory there".
    slug = `vitest-delete-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    projectDir = join(CODING_ROOT, slug);
    mkdirSync(join(projectDir, "src"), { recursive: true });
    mkdirSync(join(projectDir, ".ducki-checkpoints"), { recursive: true });
    writeFileSync(join(projectDir, "index.html"), "<h1>hi</h1>");
    writeFileSync(join(projectDir, "src", "app.js"), "console.log(1);");
    writeFileSync(join(projectDir, ".ducki-checkpoints", "HEAD"), "ref: refs/heads/master");
  });

  afterEach(async () => {
    rmSync(projectDir, { recursive: true, force: true });
    await Promise.all(openServers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  it("previews the files and chats it would remove", async () => {
    const { db } = mockDb([{ id: 1, name: `[Coding] ${slug}` }]);
    const base = await startTestServer(db);

    const body = (await (await fetch(`${base}/projects/${slug}/deletion-preview`)).json()) as any;

    // The checkpoint store is machinery, not user files, and stays out of the count.
    expect(body.data.fileCount).toBe(2);
    expect(body.data.conversations).toHaveLength(1);
    expect(body.data.conversations[0].messageCount).toBe(2);
  });

  it("removes the directory and the project's own chat", async () => {
    const { db, rows } = mockDb([{ id: 1, name: `[Coding] ${slug}` }]);
    const base = await startTestServer(db);

    const body = (await (await fetch(`${base}/projects/${slug}`, { method: "DELETE" })).json()) as any;

    expect(body.data.deleted).toBe(true);
    expect(body.data.deletedConversationIds).toEqual([1]);
    expect(existsSync(projectDir)).toBe(false);
    expect(rows.has(1)).toBe(false);
  });

  it("leaves other projects' chats and ordinary chats alone", async () => {
    const { db, rows } = mockDb([
      { id: 1, name: `[Coding] ${slug}` },
      { id: 2, name: "[Coding] some-other-project" },
      { id: 3, name: "Normaler Chat" },
    ]);
    const base = await startTestServer(db);

    await fetch(`${base}/projects/${slug}`, { method: "DELETE" });

    expect(rows.has(1)).toBe(false);
    expect(rows.has(2)).toBe(true);
    expect(rows.has(3)).toBe(true);
  });

  it("ignores a stale conversationId that belongs to a different coding project", async () => {
    // localStorage can outlive a project. A wrong id must never widen the blast radius.
    const { db, rows } = mockDb([
      { id: 1, name: `[Coding] ${slug}` },
      { id: 2, name: "[Coding] some-other-project" },
    ]);
    const base = await startTestServer(db);

    await fetch(`${base}/projects/${slug}?conversationId=2`, { method: "DELETE" });

    expect(rows.has(1)).toBe(false);
    expect(rows.has(2)).toBe(true);
  });

  it("also deletes a chat known only to the caller", async () => {
    // A conversation the user renamed no longer matches the naming convention, so the id the
    // client remembers is the only way to find it.
    const { db, rows } = mockDb([{ id: 7, name: "Mein umbenannter Coding-Chat" }]);
    const base = await startTestServer(db);

    await fetch(`${base}/projects/${slug}?conversationId=7`, { method: "DELETE" });

    expect(rows.has(7)).toBe(false);
  });

  it("refuses a path that escapes the coding root", async () => {
    const { db } = mockDb([]);
    const base = await startTestServer(db);

    const response = await fetch(`${base}/projects/${encodeURIComponent("../../etc")}`, { method: "DELETE" });

    expect(response.ok).toBe(false);
    expect(existsSync(projectDir)).toBe(true);
  });

  it("404s for a project that does not exist", async () => {
    const { db } = mockDb([]);
    const base = await startTestServer(db);

    const response = await fetch(`${base}/projects/definitely-not-a-project-xyz`, { method: "DELETE" });

    expect(response.status).toBe(404);
  });
});
