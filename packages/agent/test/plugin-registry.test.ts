import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadPlugins, listPluginSkillDirs } from "../src/plugins/index.ts";

describe("plugin registry", () => {
  it("ignores the shared node_modules and dot-folders next to plugins", async () => {
    const root = mkdtempSync(join(tmpdir(), "ducki-plugins-"));
    try {
      mkdirSync(join(root, "node_modules", "ws"), { recursive: true });
      writeFileSync(join(root, "node_modules", "ws", "package.json"), "{}");
      mkdirSync(join(root, ".cache"));
      const loaded = await loadPlugins(root);
      expect(loaded.plugins).toEqual([]);
      expect(listPluginSkillDirs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
