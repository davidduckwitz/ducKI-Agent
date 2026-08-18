import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePluginDir } from "../src/plugins/validate-cli.js";

function writeManifest(root: string, name: string, manifest: Record<string, unknown>): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
}

describe("validatePluginDir (agent-authored plugin safety gate)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ducki-plugin-validate-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts a minimal valid manifest", () => {
    writeManifest(root, "my-plugin", {
      name: "my-plugin",
      version: "1.0.0",
      description: "A test plugin",
      provides: {},
    });
    const result = validatePluginDir(root, "my-plugin");
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a missing plugin.json", () => {
    mkdirSync(join(root, "empty-plugin"), { recursive: true });
    const result = validatePluginDir(root, "empty-plugin");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/plugin.json not found/);
  });

  it("rejects trust: node", () => {
    writeManifest(root, "risky-plugin", {
      name: "risky-plugin",
      version: "1.0.0",
      description: "test",
      trust: "node",
      provides: {},
    });
    const result = validatePluginDir(root, "risky-plugin");
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('trust: "node"'))).toBe(true);
  });

  it("rejects moduleTools", () => {
    writeManifest(root, "module-plugin", {
      name: "module-plugin",
      version: "1.0.0",
      description: "test",
      trust: "node",
      provides: { moduleTools: ["tools/mod.js"] },
    });
    const result = validatePluginDir(root, "module-plugin");
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("moduleTools"))).toBe(true);
  });

  it("rejects a name mismatch between manifest and directory", () => {
    writeManifest(root, "dir-name", {
      name: "other-name",
      version: "1.0.0",
      description: "test",
      provides: {},
    });
    const result = validatePluginDir(root, "dir-name");
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("must match the plugin directory name"))).toBe(true);
  });

  it("rejects a settingsPage (no browser-rendered surfaces for agent-authored plugins)", () => {
    writeManifest(root, "ui-plugin", {
      name: "ui-plugin",
      version: "1.0.0",
      description: "test",
      provides: { settingsPage: "settings/index.html" },
    });
    const result = validatePluginDir(root, "ui-plugin");
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("provides.settingsPage"))).toBe(true);
  });

  it("rejects a referenced scriptTools file that does not exist", () => {
    writeManifest(root, "broken-tool-plugin", {
      name: "broken-tool-plugin",
      version: "1.0.0",
      description: "test",
      provides: { scriptTools: ["tools/missing.tool.json"] },
    });
    const result = validatePluginDir(root, "broken-tool-plugin");
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("does not exist"))).toBe(true);
  });

  it("accepts a valid data-source plugin matching the exchange-rates reference shape", () => {
    const dir = join(root, "rates-plugin");
    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(
      join(dir, "tools", "rates.datasource.json"),
      JSON.stringify({ name: "rates", requests: [{ urlTemplate: "https://api.example.com/{base}" }] }),
      "utf8"
    );
    writeManifest(root, "rates-plugin", {
      name: "rates-plugin",
      version: "1.0.0",
      description: "test",
      provides: { dataSourceTools: ["tools/rates.datasource.json"] },
    });
    const result = validatePluginDir(root, "rates-plugin");
    expect(result.ok).toBe(true);
  });
});
