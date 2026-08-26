import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// A per-conversation temp dir instead of the real repo-local workspace, so parallel test files
// (all starting at conversation id 1) never race on the same shared-workspace/bot-groups/N path.
const wsState = vi.hoisted(() => ({ dirs: new Map<number, string>() }));

vi.mock("../lib/shared-workspace-service.js", async () => {
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return {
    sharedWorkspace: {
      resolveGroupWorkspace: (chatId: number) => {
        let dir = wsState.dirs.get(chatId);
        if (!dir) {
          dir = mkdtempSync(join(tmpdir(), "ducki-ws-"));
          for (const sub of ["", "files", "output", "archive"]) {
            mkdirSync(sub ? join(dir, sub) : dir, { recursive: true });
          }
          wsState.dirs.set(chatId, dir);
        }
        return dir;
      },
      getWorkspaceContext: () => "",
    },
  };
});

import { DatabaseService } from "@ducki/database";
import { botChatsRouter } from "./bot-chats.js";
import { sharedWorkspace } from "../lib/shared-workspace-service.js";

const servers: Server[] = [];
const databases: DatabaseService[] = [];
const cleanupDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of databases) (db as unknown as { close?: () => void }).close?.();
  databases.length = 0;
  for (const dir of wsState.dirs.values()) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may hold a file briefly - the OS cleans it up.
    }
  }
  wsState.dirs.clear();
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold the libsql file briefly after close - the OS cleans it up.
    }
  }
  cleanupDirs.length = 0;
});

async function startApp(db: DatabaseService): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.locals["db"] = db;
  app.use("/api/bot-chats", botChatsRouter);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to acquire test server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "ducki-plan-route-"));
  cleanupDirs.push(dir);
  const db = new DatabaseService(join(dir, "test.db"));
  await db.initialize();
  databases.push(db);
  const conversation = await db.createConversation({ name: "Plan Room", origin: "bot_chat" });
  const app = await startApp(db);
  return { db, conversation, app };
}

describe("PUT /api/bot-chats/:id/plan", () => {
  it("edits the plan artifact and syncs the tagged plan message", async () => {
    const { db, conversation, app } = await makeHarness();
    const workspaceDir = sharedWorkspace.resolveGroupWorkspace(conversation.id);
    cleanupDirs.push(workspaceDir);
    const planPath = join(workspaceDir, "output", "plan-refactor-1.md");
    writeFileSync(planPath, "# Refactor Plan\n\nold steps", "utf8");
    await db.addMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: `## 📋 Gemeinsamer Plan\n\n# Refactor Plan\n\nold steps\n\n_Plan gespeichert: ${planPath}_`,
      authorBotId: "main",
      metadata: JSON.stringify({ plan: true, planPath }),
    });

    const response = await fetch(`${app.baseUrl}/api/bot-chats/${conversation.id}/plan`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: planPath, content: "# Refactor Plan\n\n1. New step A\n2. New step B" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data?: { path: string; updated: boolean } };
    expect(body.data?.updated).toBe(true);
    expect(body.data?.path).toBe(planPath);

    // The file on disk changed, so a follow-up execution message picks up the edited version.
    expect(readFileSync(planPath, "utf8")).toContain("1. New step A");
    // The transcript row was re-wrapped and updated too.
    const messages = await db.getMessages(conversation.id);
    const planRow = messages.find((m) => m.metadata?.includes("\"plan\":true"));
    expect(planRow).toBeTruthy();
    expect(planRow!.content).toContain("1. New step A");
    expect(planRow!.content).toContain("_Plan gespeichert:");
  });

  it("rejects a path that escapes the group workspace", async () => {
    const { db, conversation, app } = await makeHarness();
    const workspaceDir = sharedWorkspace.resolveGroupWorkspace(conversation.id);
    cleanupDirs.push(workspaceDir);
    const escapedPath = join(workspaceDir, "..", "escape.md");

    const response = await fetch(`${app.baseUrl}/api/bot-chats/${conversation.id}/plan`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: escapedPath, content: "pwned" }),
    });

    expect(response.status).toBe(403);
    // Nothing was written outside the workspace.
    expect(() => readFileSync(join(workspaceDir, "..", "escape.md"), "utf8")).toThrow();
  });

  it("rejects non-markdown paths and unknown chats", async () => {
    const { conversation, app } = await makeHarness();
    const workspaceDir = sharedWorkspace.resolveGroupWorkspace(conversation.id);
    cleanupDirs.push(workspaceDir);

    const notMarkdown = await fetch(`${app.baseUrl}/api/bot-chats/${conversation.id}/plan`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: join(workspaceDir, "output", "notes.txt"), content: "x" }),
    });
    expect(notMarkdown.status).toBe(400);

    const missingChat = await fetch(`${app.baseUrl}/api/bot-chats/999999/plan`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "output/plan-x.md", content: "x" }),
    });
    expect(missingChat.status).toBe(404);
  });
});
