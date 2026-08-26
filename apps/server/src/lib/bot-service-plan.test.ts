import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotSelect } from "@ducki/database";

vi.mock("@ducki/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ducki/agent")>();
  return {
    ...actual,
    Planner: vi.fn().mockImplementation(() => ({
      createPlan: vi.fn(async (goal: string) => ({ goal, steps: [{ description: "Erster Schritt", dependsOn: [] }] })),
    })),
    formatPlanAsMarkdown: vi.fn(() => "# Neuer Plan\n\n1. Erster Schritt"),
  };
});

// A per-conversation temp dir instead of the real repo-local workspace, so parallel test files
// (all starting at conversation id 1) never race on the same shared-workspace/bot-groups/N path.
const wsState = vi.hoisted(() => ({ dirs: new Map<number, string>() }));

vi.mock("./shared-workspace-service.js", async () => {
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
import { BotService } from "./bot-service.js";
import { sharedWorkspace } from "./shared-workspace-service.js";

const cleanupDirs: string[] = [];
const databases: DatabaseService[] = [];

afterEach(async () => {
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
      // Windows may hold the libsql file briefly after close - the OS cleans it up.
    }
  }
  cleanupDirs.length = 0;
});

function bot(slug: string): BotSelect {
  return {
    slug,
    name: slug.toUpperCase(),
    description: null,
    avatar: null,
    systemPrompt: null,
    providerId: null,
    modelId: null,
    skillWhitelist: null,
    toolWhitelist: null,
    isBuiltIn: 0,
    conversationId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as BotSelect;
}

async function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "ducki-plan-arch-"));
  cleanupDirs.push(dir);
  const db = new DatabaseService(join(dir, "test.db"));
  await db.initialize();
  databases.push(db);
  const service = new BotService({
    db,
    providerRef: { current: {} as never },
    runtimeTools: [],
    pluginManager: { getTools: () => [] },
    createAgent: vi.fn(),
    createCodingAgentFactory: vi.fn(),
  });
  return { db, service };
}

describe("BotService plan lifecycle", () => {
  it("archives the previously-active plan when a new planning exchange converges", async () => {
    const { db, service } = await makeHarness();
    const conversation = await db.createConversation({ name: "Plan Room", origin: "bot_chat" });
    const workspaceDir = sharedWorkspace.resolveGroupWorkspace(conversation.id);
    cleanupDirs.push(workspaceDir);
    const outputDir = join(workspaceDir, "output");
    const archiveDir = join(outputDir, "archive");

    // Old plan: file + tagged message row.
    const oldPath = join(outputDir, "plan-refactor-123.md");
    writeFileSync(oldPath, "# Alter Plan", "utf8");
    await db.addMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: "## 📋 Gemeinsamer Plan\n\n# Alter Plan\n\n_Plan gespeichert: weg_",
      authorBotId: "main",
      metadata: JSON.stringify({ plan: true, planPath: oldPath }),
    });

    // New planning exchange converges.
    const result = await service.synthesizeTeamPlan("Neues Vorhaben", conversation.id, bot("main"));

    // The old file moved to output/archive/; only the new plan remains in output/ - so
    // findActivePlan can only ever see the current plan.
    expect(existsSync(oldPath)).toBe(false);
    expect(readFileSync(join(archiveDir, "plan-refactor-123.md"), "utf8")).toContain("Alter Plan");
    const outputPlans = readdirSync(outputDir).filter((name) => name.startsWith("plan-") && name.endsWith(".md"));
    const newBasename = result.path.split(/[\\/]/).pop()!;
    expect(outputPlans).toEqual([newBasename]);

    // Old message row is tagged archived; the new row is the active plan.
    // (Match on basenames - the JSON-encoded metadata escapes the path separators.)
    const messages = await db.getMessages(conversation.id);
    const oldRow = messages.find((m) => m.metadata?.includes("plan-refactor-123.md"));
    expect(oldRow).toBeTruthy();
    expect(oldRow!.metadata).toContain("\"archived\":true");
    const newRow = messages.find((m) => m.metadata?.includes(newBasename));
    expect(newRow).toBeTruthy();
    expect(newRow!.metadata).toContain("\"plan\":true");
    expect(newRow!.metadata).not.toContain("archived");
  });

  it("leaves the workspace untouched when no previous plan exists", async () => {
    const { db, service } = await makeHarness();
    const conversation = await db.createConversation({ name: "Plan Room", origin: "bot_chat" });
    const workspaceDir = sharedWorkspace.resolveGroupWorkspace(conversation.id);
    cleanupDirs.push(workspaceDir);
    const outputDir = join(workspaceDir, "output");

    const result = await service.synthesizeTeamPlan("Erstes Vorhaben", conversation.id, bot("main"));

    const outputPlans = readdirSync(outputDir).filter((name) => name.startsWith("plan-") && name.endsWith(".md"));
    expect(outputPlans).toEqual([result.path.split(/[\\/]/).pop()]);
    const messages = await db.getMessages(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.metadata).toContain("\"plan\":true");
  });
});
