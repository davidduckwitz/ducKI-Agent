import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlugins, listPluginSkillDirs } from "../src/plugins/index.ts";
import { closeAllPluginDbs } from "@ducki/database";

// Relative to THIS test file (vitest's process.cwd() is the repo root, not packages/agent).
const REPO_PLUGINS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins");

beforeAll(() => {
  process.env.DUCKI_PLUGINS_DIR = REPO_PLUGINS;
});
afterAll(() => {
  closeAllPluginDbs();
  delete process.env.DUCKI_PLUGINS_DIR;
});

describe("plugin registry (real plugins/ dir)", () => {
  it("loads the reference plugins and their tools + skills", async () => {
    const loaded = await loadPlugins(REPO_PLUGINS);
    const toolNames = loaded.tools.map((t) => t.name);
    expect(toolNames).toContain("exchange_rates");
    expect(toolNames).toContain("notes");

    const names = loaded.plugins.map((p) => p.name);
    expect(names).toContain("exchange-rates");
    expect(names).toContain("notes");
    expect(loaded.plugins.find((p) => p.name === "notes")?.hasStorage).toBe(true);
    expect(loaded.plugins.every((p) => !p.error)).toBe(true);

    // Plugins with storage.sqlite auto-expose a generic <name>_storage tool for the agent.
    expect(toolNames).toContain("notes_storage");

    const skillDirs = listPluginSkillDirs(REPO_PLUGINS);
    expect(skillDirs.some((d) => d.includes("exchange-rates-usage"))).toBe(true);
    expect(skillDirs.some((d) => d.includes("notes-usage"))).toBe(true);
  });

  it("notes tool persists to its own sqlite db (add then list)", async () => {
    const loaded = await loadPlugins(REPO_PLUGINS);
    const notes = loaded.tools.find((t) => t.name === "notes");
    expect(notes).toBeDefined();

    const marker = `test-note-${Date.now()}`;
    const add = await notes!.execute({ action: "add", text: marker });
    expect(add.success).toBe(true);

    const list = await notes!.execute({ action: "list" });
    expect(list.success).toBe(true);
    const rows = (list.data as { result: { notes: Array<{ text: string }> } }).result.notes;
    expect(rows.some((r) => r.text === marker)).toBe(true);
  });

  it("auto storage tool can query the plugin's own db and blocks non-SELECT queries", async () => {
    const loaded = await loadPlugins(REPO_PLUGINS);
    const storageTool = loaded.tools.find((t) => t.name === "notes_storage");
    expect(storageTool).toBeDefined();

    const rows = await storageTool!.execute({ action: "query", sql: "SELECT COUNT(*) AS n FROM notes" });
    expect(rows.success).toBe(true);
    expect((rows.data as { result: { count: number } }).result.count).toBe(1);

    const blocked = await storageTool!.execute({ action: "query", sql: "DELETE FROM notes" });
    expect(blocked.success).toBe(false);
    expect(blocked.error).toMatch(/SELECT/i);
  });
});
