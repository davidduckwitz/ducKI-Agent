import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadToolManifests,
  isToolActive,
  getCoreToolNames,
  parseEnabledToolNamesSetting,
} from "../src/tools/tool-registry.ts";

function writeToolManifest(root: string, name: string, frontmatter: Record<string, string>): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const lines = ["---", ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`), "---", "", `# ${name}`];
  writeFileSync(join(dir, "TOOL.md"), lines.join("\n"), "utf8");
}

describe("tool-registry", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ducki-tool-registry-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("parses core and optional manifests from TOOL.md frontmatter", () => {
    writeToolManifest(root, "filesystem", { name: "filesystem", description: "Read/write files", core: "true" });
    writeToolManifest(root, "shell", { name: "shell", description: "Run shell commands", core: "false" });

    const manifests = loadToolManifests(root);

    expect(manifests).toHaveLength(2);
    const filesystem = manifests.find((m) => m.name === "filesystem");
    const shell = manifests.find((m) => m.name === "shell");
    expect(filesystem?.core).toBe(true);
    expect(shell?.core).toBe(false);
  });

  it("defaults a manifest without an explicit core flag to optional", () => {
    writeToolManifest(root, "http", { name: "http", description: "Make HTTP requests" });
    const manifests = loadToolManifests(root);
    expect(manifests[0]?.core).toBe(false);
  });

  it("returns an empty list when the tools root does not exist", () => {
    expect(loadToolManifests(join(root, "does-not-exist"))).toEqual([]);
  });

  it("getCoreToolNames returns only tools marked core: true", () => {
    writeToolManifest(root, "filesystem", { name: "filesystem", core: "true" });
    writeToolManifest(root, "shell", { name: "shell", core: "false" });
    const manifests = loadToolManifests(root);
    expect(getCoreToolNames(manifests)).toEqual(new Set(["filesystem"]));
  });

  describe("isToolActive", () => {
    it("is always active for a core tool regardless of the enabled allowlist", () => {
      writeToolManifest(root, "filesystem", { name: "filesystem", core: "true" });
      const manifests = loadToolManifests(root);
      expect(isToolActive("filesystem", manifests, new Set())).toBe(true);
    });

    it("is inactive for an optional tool not in the enabled allowlist", () => {
      writeToolManifest(root, "shell", { name: "shell", core: "false" });
      const manifests = loadToolManifests(root);
      expect(isToolActive("shell", manifests, new Set())).toBe(false);
    });

    it("is active for an optional tool present in the enabled allowlist", () => {
      writeToolManifest(root, "shell", { name: "shell", core: "false" });
      const manifests = loadToolManifests(root);
      expect(isToolActive("shell", manifests, new Set(["shell"]))).toBe(true);
    });

    it("treats a tool with no manifest entry as active (e.g. a dynamic tool_factory tool)", () => {
      writeToolManifest(root, "shell", { name: "shell", core: "false" });
      const manifests = loadToolManifests(root);
      expect(isToolActive("my_dynamic_tool", manifests, new Set())).toBe(true);
    });

    it("accepts a plain string array for the enabled list, not just a Set", () => {
      writeToolManifest(root, "shell", { name: "shell", core: "false" });
      const manifests = loadToolManifests(root);
      expect(isToolActive("shell", manifests, ["shell"])).toBe(true);
    });
  });

  describe("parseEnabledToolNamesSetting", () => {
    it("parses a JSON array of tool names", () => {
      expect(parseEnabledToolNamesSetting('["shell", "http"]')).toEqual(["shell", "http"]);
    });

    it("returns an empty array for missing, empty, or invalid input", () => {
      expect(parseEnabledToolNamesSetting(undefined)).toEqual([]);
      expect(parseEnabledToolNamesSetting("")).toEqual([]);
      expect(parseEnabledToolNamesSetting("not json")).toEqual([]);
      expect(parseEnabledToolNamesSetting("{}")).toEqual([]);
    });

    it("lowercases entries and drops values with invalid characters", () => {
      expect(parseEnabledToolNamesSetting('["Shell", "bad name!", "http"]')).toEqual(["shell", "http"]);
    });
  });
});
