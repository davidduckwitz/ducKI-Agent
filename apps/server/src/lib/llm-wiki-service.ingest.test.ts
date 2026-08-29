import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseService } from "@ducki/database";
import { SHARED_WORKSPACE_ROOT } from "@ducki/tools";
import { LlmWikiService } from "./llm-wiki-service.js";

/**
 * Exercises the full ingest pipeline against a real folder that stands in for an
 * Obsidian vault: frontmatter tags, [[wikilinks]] (resolved and unresolved), an
 * ignored .obsidian/ folder, and the soft-delete semantics of syncParsedLlmWikiLinks
 * across repeated ingest cycles.
 */
describe("LlmWikiService ingestion (Obsidian-style vault)", () => {
  let dbDir: string;
  let db: DatabaseService;
  let vaultRelName: string;
  let vaultAbsPath: string;
  let previousSourcePathEnv: string | undefined;

  beforeEach(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "ducki-wiki-db-"));
    db = new DatabaseService(join(dbDir, "test.db"));
    await db.initialize();

    vaultRelName = `llm-wiki-test-${Math.random().toString(36).slice(2, 8)}`;
    vaultAbsPath = resolve(SHARED_WORKSPACE_ROOT, vaultRelName);
    mkdirSync(vaultAbsPath, { recursive: true });

    // resolveWikiRoot() prefers the WIKI_SHARED_SOURCE_PATH db setting and falls back
    // to this env var - set both here so tests that don't touch the db setting still work.
    previousSourcePathEnv = process.env["WIKI_SHARED_SOURCE_PATH"];
    process.env["WIKI_SHARED_SOURCE_PATH"] = vaultRelName;

    await db.setSetting("WIKI_ENABLED", "true");
    await db.setSetting("WIKI_AUTO_APPROVE", "true");
    await db.setSetting("WIKI_SHARED_SOURCE_AUTO_MEMORY", "false");
  });

  afterEach(() => {
    (db as unknown as { client?: { close?: () => void } }).client?.close?.();
    if (previousSourcePathEnv === undefined) delete process.env["WIKI_SHARED_SOURCE_PATH"];
    else process.env["WIKI_SHARED_SOURCE_PATH"] = previousSourcePathEnv;
    try {
      rmSync(dbDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    try {
      rmSync(vaultAbsPath, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  function writeVaultFile(relPath: string, content: string): void {
    const abs = join(vaultAbsPath, relPath);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  it("ingests frontmatter tags, resolves/unresolves wikilinks, and ignores .obsidian", async () => {
    writeVaultFile(
      "foo.md",
      ["---", "tags: [project, todo]", "---", "# Foo", "See [[Bar]] and [[Nonexistent Note]]."].join("\n")
    );
    writeVaultFile("bar.md", "# Bar\nJust a plain note.");
    writeVaultFile(".obsidian/workspace.json", '{"should":"be ignored"}');

    const service = new LlmWikiService(db, { info: () => {}, warn: () => {} } as never);
    await service.ingestNow();

    const entries = await db.listLlmWikiEntries(100);
    const fooChunk1 = entries.find((e) => e.sourcePath === "foo.md#chunk-1");
    expect(fooChunk1).toBeDefined();
    const meta = JSON.parse(fooChunk1!.metadata ?? "{}");
    expect(meta.tags).toEqual(["project", "todo"]);

    const ignoredEntry = entries.find((e) => e.sourcePath.includes(".obsidian"));
    expect(ignoredEntry).toBeUndefined();

    const links = await db.listLlmWikiLinks("all");
    const barLink = links.find((l) => l.sourceFile === "foo.md" && l.targetRaw === "Bar");
    expect(barLink?.targetFile).toBe("bar.md");
    expect(barLink?.status).toBe("active");

    const brokenLink = links.find((l) => l.sourceFile === "foo.md" && l.targetRaw === "Nonexistent Note");
    expect(brokenLink?.targetFile).toBeNull();
  });

  it("keeps a manually-deleted link removed across re-ingest, and marks a link removed when the [[...]] text disappears from the file", async () => {
    writeVaultFile("a.md", "[[B]]");
    writeVaultFile("b.md", "# B");

    const service = new LlmWikiService(db, { info: () => {}, warn: () => {} } as never);
    await service.ingestNow();

    const firstPass = await db.listLlmWikiLinks("active");
    const link = firstPass.find((l) => l.sourceFile === "a.md" && l.targetRaw === "B");
    expect(link).toBeDefined();

    // Simulate the user soft-deleting the link via the graph UI.
    await db.removeLlmWikiLink(link!.id);

    // Content unchanged -> contentHash matches -> ingest skips the file entirely, so
    // the manual deletion must survive without being reconsidered at all.
    await service.ingestNow();
    let afterFirstReingest = await db.listLlmWikiLinks("all");
    let stillRemoved = afterFirstReingest.find((l) => l.id === link!.id);
    expect(stillRemoved?.status).toBe("removed");

    // Now change the file content (forces a re-parse) but keep the [[B]] text - the
    // deleted link must stay deleted, not reappear just because the raw text is there.
    writeVaultFile("a.md", "[[B]] plus more text to change the hash.");
    await service.ingestNow();
    afterFirstReingest = await db.listLlmWikiLinks("all");
    stillRemoved = afterFirstReingest.find((l) => l.id === link!.id);
    expect(stillRemoved?.status).toBe("removed");

    // Finally, remove the [[B]] text from a DIFFERENT source file's link to prove the
    // content-driven auto-removal path works for links the user never touched.
    writeVaultFile("c.md", "[[B]]");
    await service.ingestNow();
    const cLinks = await db.listLlmWikiLinks("active");
    expect(cLinks.some((l) => l.sourceFile === "c.md" && l.targetRaw === "B")).toBe(true);

    writeVaultFile("c.md", "No links here anymore.");
    await service.ingestNow();
    const cLinksAfter = await db.listLlmWikiLinks("all");
    const cLink = cLinksAfter.find((l) => l.sourceFile === "c.md" && l.targetRaw === "B");
    expect(cLink?.status).toBe("removed");
  });

  it("preserves a manually-added link across re-ingest of unrelated files", async () => {
    writeVaultFile("x.md", "# X");
    writeVaultFile("y.md", "# Y");

    const service = new LlmWikiService(db, { info: () => {}, warn: () => {} } as never);
    await service.ingestNow();

    const manual = await db.createManualLink("x.md", "y.md");
    expect(manual.origin).toBe("manual");

    await service.ingestNow();
    const links = await db.listLlmWikiLinks("active");
    expect(links.some((l) => l.id === manual.id && l.status === "active")).toBe(true);
  });

  it("prunes entries and links when a vault file is deleted by hand on disk", async () => {
    writeVaultFile("keep.md", "# Keep\n[[Deleted]]");
    writeVaultFile("deleted.md", "# Deleted\n[[Keep]]");

    const service = new LlmWikiService(db, { info: () => {}, warn: () => {} } as never);
    await service.ingestNow();

    let entries = await db.listLlmWikiEntries(100);
    expect(entries.some((e) => e.sourcePath.startsWith("deleted.md#"))).toBe(true);
    let links = await db.listLlmWikiLinks("active");
    expect(links.some((l) => l.sourceFile === "deleted.md" && l.targetFile === "keep.md")).toBe(true);
    expect(links.some((l) => l.sourceFile === "keep.md" && l.targetFile === "deleted.md")).toBe(true);

    unlinkSync(join(vaultAbsPath, "deleted.md"));
    const stats = await service.ingestNow();
    expect(stats.prunedFiles).toBe(1);

    entries = await db.listLlmWikiEntries(100);
    expect(entries.some((e) => e.sourcePath.startsWith("deleted.md#"))).toBe(false);

    links = await db.listLlmWikiLinks("all");
    const deletedFileOwnLink = links.find((l) => l.sourceFile === "deleted.md" && l.targetRaw === "Keep");
    expect(deletedFileOwnLink?.status).toBe("removed");

    const incomingLinkFromKeep = links.find((l) => l.sourceFile === "keep.md" && l.targetRaw === "Deleted");
    expect(incomingLinkFromKeep?.status).toBe("active");
    expect(incomingLinkFromKeep?.targetFile).toBeNull();

    const activeLinks = await db.listLlmWikiLinks("active");
    expect(activeLinks.some((l) => l.sourceFile === "deleted.md")).toBe(false);
  });

  it("prefers the WIKI_SHARED_SOURCE_PATH db setting over the env var (UI-configured vault wins)", async () => {
    const dbConfiguredRelName = `llm-wiki-db-setting-${Math.random().toString(36).slice(2, 8)}`;
    const dbConfiguredAbsPath = resolve(SHARED_WORKSPACE_ROOT, dbConfiguredRelName);
    mkdirSync(dbConfiguredAbsPath, { recursive: true });
    writeFileSync(join(dbConfiguredAbsPath, "only-in-db-vault.md"), "# Only here", "utf8");

    try {
      await db.setSetting("WIKI_SHARED_SOURCE_PATH", dbConfiguredRelName);

      const service = new LlmWikiService(db, { info: () => {}, warn: () => {} } as never);
      await service.ingestNow();

      const entries = await db.listLlmWikiEntries(100);
      expect(entries.some((e) => e.sourcePath.startsWith("only-in-db-vault.md#"))).toBe(true);
    } finally {
      rmSync(dbConfiguredAbsPath, { recursive: true, force: true });
    }
  });

  describe("\"Befehl\"/\"command\" tag promotion", () => {
    it("promotes a tagged note to a guaranteed-present importance-9 long-term memory", async () => {
      writeVaultFile("licht-aus.md", ["---", "tags: [befehl]", "---", "Wenn ich 'Nachtmodus' sage, schalte alle Lichter aus."].join("\n"));
      const service = new LlmWikiService(db, { info: () => {}, warn: () => {} } as never);
      await service.ingestNow();

      const longTerm = await db.getMemories(undefined, "long-term");
      const promoted = longTerm.find((m) => m.content.startsWith("[PROFILE:COMMAND:licht-aus.md]"));
      expect(promoted).toBeDefined();
      expect(promoted?.importance).toBe(9);
      expect(promoted?.content).toContain("Nachtmodus");
    });

    it("accepts the English 'command' tag as a synonym", async () => {
      writeVaultFile("night-mode.md", ["---", "tags: [command]", "---", "When I say 'night mode', turn off all lights."].join("\n"));
      const service = new LlmWikiService(db, { info: () => {}, warn: () => {} } as never);
      await service.ingestNow();

      const longTerm = await db.getMemories(undefined, "long-term");
      expect(longTerm.some((m) => m.content.startsWith("[PROFILE:COMMAND:night-mode.md]"))).toBe(true);
    });

    it("does not promote a note without the tag", async () => {
      writeVaultFile("just-a-note.md", "# Just a note\nNothing special here.");
      const service = new LlmWikiService(db, { info: () => {}, warn: () => {} } as never);
      await service.ingestNow();

      const longTerm = await db.getMemories(undefined, "long-term");
      expect(longTerm.some((m) => m.content.includes("just-a-note.md"))).toBe(false);
    });

    it("updates the promoted memory in place on re-ingest instead of duplicating it", async () => {
      writeVaultFile("licht-aus.md", ["---", "tags: [befehl]", "---", "Version eins des Befehls."].join("\n"));
      const service = new LlmWikiService(db, { info: () => {}, warn: () => {} } as never);
      await service.ingestNow();

      writeVaultFile("licht-aus.md", ["---", "tags: [befehl]", "---", "Version zwei des Befehls."].join("\n"));
      await service.ingestNow();

      const longTerm = await db.getMemories(undefined, "long-term");
      const matches = longTerm.filter((m) => m.content.startsWith("[PROFILE:COMMAND:licht-aus.md]"));
      expect(matches).toHaveLength(1);
      expect(matches[0]?.content).toContain("Version zwei");
      expect(matches[0]?.content).not.toContain("Version eins");
    });

    it("demotes the memory when the tag is removed from the note", async () => {
      writeVaultFile("licht-aus.md", ["---", "tags: [befehl]", "---", "Ein Befehl."].join("\n"));
      const service = new LlmWikiService(db, { info: () => {}, warn: () => {} } as never);
      await service.ingestNow();
      expect((await db.getMemories(undefined, "long-term")).some((m) => m.content.startsWith("[PROFILE:COMMAND:licht-aus.md]"))).toBe(true);

      writeVaultFile("licht-aus.md", "Kein Befehl mehr, nur eine normale Notiz.");
      await service.ingestNow();

      expect((await db.getMemories(undefined, "long-term")).some((m) => m.content.startsWith("[PROFILE:COMMAND:licht-aus.md]"))).toBe(false);
    });

    it("demotes the memory when the tagged file is deleted", async () => {
      writeVaultFile("licht-aus.md", ["---", "tags: [befehl]", "---", "Ein Befehl."].join("\n"));
      const service = new LlmWikiService(db, { info: () => {}, warn: () => {} } as never);
      await service.ingestNow();
      expect((await db.getMemories(undefined, "long-term")).some((m) => m.content.startsWith("[PROFILE:COMMAND:licht-aus.md]"))).toBe(true);

      unlinkSync(join(vaultAbsPath, "licht-aus.md"));
      await service.ingestNow();

      expect((await db.getMemories(undefined, "long-term")).some((m) => m.content.startsWith("[PROFILE:COMMAND:licht-aus.md]"))).toBe(false);
    });
  });
});
