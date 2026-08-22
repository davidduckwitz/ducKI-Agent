import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseService } from "./index.ts";

/**
 * Regression coverage for hiding CodingAgent-originated conversations from the normal chat
 * overview (listConversations/listConversationsPage default to excluding origin="coding_agent").
 *
 * The NULL-safety of the exclusion is the part worth pinning down: `origin != 'coding_agent'`
 * alone evaluates to NULL (excluded by SQL's WHERE) for every row where origin IS NULL - which
 * is every normal chat conversation - so a naive `ne()` filter would have silently hidden ALL
 * regular chats instead of just the coding ones.
 */
describe("DatabaseService conversation origin filtering", () => {
  let dir: string;
  let service: DatabaseService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ducki-db-origin-"));
    service = new DatabaseService(join(dir, "test.db"));
    await service.initialize();
  });

  afterEach(() => {
    (service as unknown as { client?: { close?: () => void } }).client?.close?.();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The OS cleans up its own temp directory.
    }
  });

  it("listConversations excludes origin=coding_agent by default, keeps normal (origin=NULL) chats", async () => {
    await service.createConversation({ name: "Normal chat" });
    await service.createConversation({ name: "CodingAgent: build the thing", origin: "coding_agent" });

    const shown = await service.listConversations();
    expect(shown.map((c) => c.name)).toEqual(["Normal chat"]);
  });

  it("listConversations(projectId, true) includes coding_agent conversations when opted in", async () => {
    await service.createConversation({ name: "Normal chat" });
    await service.createConversation({ name: "CodingAgent: build the thing", origin: "coding_agent" });

    const all = await service.listConversations(undefined, true);
    expect(all).toHaveLength(2);
  });

  it("listConversationsPage excludes origin=coding_agent by default", async () => {
    await service.createConversation({ name: "Normal chat" });
    await service.createConversation({ name: "CodingAgent: build the thing", origin: "coding_agent" });

    const page = await service.listConversationsPage({});
    expect(page.map((c) => c.name)).toEqual(["Normal chat"]);
  });

  it("listConversationsPage(includeCodingAgent: true) includes them", async () => {
    await service.createConversation({ name: "Normal chat" });
    await service.createConversation({ name: "CodingAgent: build the thing", origin: "coding_agent" });

    const page = await service.listConversationsPage({ includeCodingAgent: true });
    expect(page).toHaveLength(2);
  });

  it("does not hide normal chats when a projectId filter is also applied", async () => {
    const project = await service.createProject({ name: "p" });
    await service.createConversation({ name: "Normal chat", projectId: project.id });
    await service.createConversation({ name: "CodingAgent: x", origin: "coding_agent", projectId: project.id });

    const shown = await service.listConversations(project.id);
    expect(shown.map((c) => c.name)).toEqual(["Normal chat"]);
  });
});
