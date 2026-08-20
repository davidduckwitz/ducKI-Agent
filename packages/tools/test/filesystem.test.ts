import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesystemTool } from "../src/filesystem.ts";

const exec = (input: Record<string, unknown>) => filesystemTool.execute(input);

describe("filesystem tool (PR3)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ducki-fs-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── Security ───────────────────────────────────────────────────────────────

  describe("path-escape prevention", () => {
    it("rejects paths outside basePath with safeMode:true", async () => {
      const result = await exec({
        action: "read",
        path: "../../etc/passwd",
        basePath: dir,
        safeMode: true,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/outside basePath/i);
    });

    it("allows paths inside basePath", async () => {
      writeFileSync(join(dir, "allowed.txt"), "ok");
      const result = await exec({
        action: "read",
        path: "allowed.txt",
        basePath: dir,
        safeMode: true,
      });
      expect(result.success).toBe(true);
      expect(result.data).toBe("1: ok");
    });

    it("returns the file verbatim with raw:true", async () => {
      writeFileSync(join(dir, "allowed.txt"), "ok");
      const result = await exec({
        action: "read",
        path: "allowed.txt",
        basePath: dir,
        safeMode: true,
        raw: true,
      });
      expect(result.success).toBe(true);
      expect(result.data).toBe("ok");
    });
  });

  // ── Redundant base-segment stripping (double-nesting guard) ──────────────────

  describe("redundant base-segment stripping", () => {
    it("does not double-nest when the path repeats the base's trailing segment", async () => {
      const base = join(dir, "shared-workspace");
      mkdirSync(base, { recursive: true });
      const result = await exec({
        action: "write",
        path: "shared-workspace/notes.txt",
        content: "hi",
        basePath: base,
        safeMode: true,
      });
      expect(result.success).toBe(true);
      // Must land directly under base, NOT base/shared-workspace/notes.txt
      expect(existsSync(join(base, "notes.txt"))).toBe(true);
      expect(existsSync(join(base, "shared-workspace", "notes.txt"))).toBe(false);
    });

    it("handles a leading ./ before the redundant segment", async () => {
      const base = join(dir, "shared-workspace");
      mkdirSync(base, { recursive: true });
      const result = await exec({
        action: "write",
        path: "./shared-workspace/sub/x.txt",
        content: "hi",
        basePath: base,
        safeMode: true,
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(base, "sub", "x.txt"))).toBe(true);
    });

    it("leaves paths untouched when they do not repeat the base segment", async () => {
      const base = join(dir, "project");
      mkdirSync(base, { recursive: true });
      const result = await exec({
        action: "write",
        path: "src/app.ts",
        content: "//",
        basePath: base,
        safeMode: true,
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(base, "src", "app.ts"))).toBe(true);
    });
  });

  // ── JSON validation ────────────────────────────────────────────────────────

  describe("JSON validation", () => {
    it("rejects invalid JSON on write to .json file", async () => {
      const result = await exec({
        action: "write",
        path: join(dir, "data.json"),
        content: "{ not valid json",
        safeMode: false,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid JSON/i);
    });

    it("allows valid JSON on write to .json file", async () => {
      const result = await exec({
        action: "write",
        path: join(dir, "data.json"),
        content: '{"ok":true}',
        safeMode: false,
      });
      expect(result.success).toBe(true);
    });
  });

  // ── atomicWrite / .bak ────────────────────────────────────────────────────

  describe("atomicWrite backup", () => {
    it("creates a .bak file when overwriting an existing file", async () => {
      const filePath = join(dir, "target.txt");
      writeFileSync(filePath, "original");

      await exec({ action: "write", path: filePath, content: "updated", safeMode: false });

      expect(readFileSync(filePath, "utf8")).toBe("updated");
      expect(existsSync(`${filePath}.bak`)).toBe(true);
      expect(readFileSync(`${filePath}.bak`, "utf8")).toBe("original");
    });
  });

  // ── edit uniqueness guard ─────────────────────────────────────────────────

  describe("edit action", () => {
    it("rejects edit when oldString is not unique", async () => {
      writeFileSync(join(dir, "dup.txt"), "foo\nfoo\nfoo");
      const result = await exec({
        action: "edit",
        path: join(dir, "dup.txt"),
        oldString: "foo",
        newString: "bar",
        safeMode: false,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not unique/i);
    });

    it("replaces all occurrences when replaceAll:true", async () => {
      writeFileSync(join(dir, "multi.txt"), "foo\nfoo\nfoo");
      const result = await exec({
        action: "edit",
        path: join(dir, "multi.txt"),
        oldString: "foo",
        newString: "bar",
        replaceAll: true,
        safeMode: false,
      });
      expect(result.success).toBe(true);
      expect(readFileSync(join(dir, "multi.txt"), "utf8")).toBe("bar\nbar\nbar");
    });

    it("rejects edit when oldString not found", async () => {
      writeFileSync(join(dir, "missing.txt"), "hello world");
      const result = await exec({
        action: "edit",
        path: join(dir, "missing.txt"),
        oldString: "notfound",
        newString: "x",
        safeMode: false,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });
  });

  // ── ranged read ───────────────────────────────────────────────────────────

  describe("ranged read", () => {
    beforeEach(() => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
      writeFileSync(join(dir, "big.txt"), lines);
    });

    it("reads lines with offset", async () => {
      const result = await exec({
        action: "read",
        path: join(dir, "big.txt"),
        offset: 10,
        safeMode: false,
      });
      expect(result.success).toBe(true);
      expect(result.data as string).toContain("line 11");
      expect(result.data as string).not.toContain("line 1\n");
    });

    it("reads lines with limit", async () => {
      const result = await exec({
        action: "read",
        path: join(dir, "big.txt"),
        offset: 0,
        limit: 5,
        safeMode: false,
      });
      expect(result.success).toBe(true);
      const lines = (result.data as string).split("\n").filter((l) => /^\d+: line /.test(l));
      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe("1: line 1");
    });

    it("truncates at maxBytes", async () => {
      const result = await exec({
        action: "read",
        path: join(dir, "big.txt"),
        maxBytes: 30,
        safeMode: false,
      });
      expect(result.success).toBe(true);
      expect(result.data as string).toContain("truncated");
    });

    it("returns range annotation when offset+limit is used", async () => {
      const result = await exec({
        action: "read",
        path: join(dir, "big.txt"),
        offset: 5,
        limit: 3,
        safeMode: false,
      });
      expect(result.success).toBe(true);
      // 12 lines remain after this window, so the footer also tells the model how to continue.
      expect(result.data as string).toContain("[lines 6-8 of 20.");
      expect(result.data as string).toContain("offset:8");
    });
  });

  // ── glob action ───────────────────────────────────────────────────────────

  describe("glob action", () => {
    beforeEach(() => {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"), "");
      writeFileSync(join(dir, "src", "b.ts"), "");
      writeFileSync(join(dir, "src", "c.js"), "");
      mkdirSync(join(dir, "src", "sub"));
      writeFileSync(join(dir, "src", "sub", "d.ts"), "");
    });

    it("finds .ts files with **/*.ts pattern", async () => {
      const result = await exec({
        action: "glob",
        path: dir,
        pattern: "**/*.ts",
        safeMode: false,
      });
      expect(result.success).toBe(true);
      const data = result.data as { matches: string[]; count: number };
      expect(data.count).toBe(3);
      expect(data.matches.some((p) => p.endsWith("a.ts"))).toBe(true);
      expect(data.matches.some((p) => p.endsWith("d.ts"))).toBe(true);
    });

    it("finds only direct .js files", async () => {
      const result = await exec({
        action: "glob",
        path: join(dir, "src"),
        pattern: "*.js",
        safeMode: false,
      });
      expect(result.success).toBe(true);
      const data = result.data as { matches: string[]; count: number };
      expect(data.count).toBe(1);
    });

    it("returns error when pattern missing", async () => {
      const result = await exec({ action: "glob", path: dir, safeMode: false });
      expect(result.success).toBe(false);
      expect(result.error).toContain("pattern required");
    });
  });

  // ── grep action ───────────────────────────────────────────────────────────

  describe("grep action", () => {
    beforeEach(() => {
      mkdirSync(join(dir, "code"));
      writeFileSync(join(dir, "code", "alpha.ts"), "export function alpha() {}\nexport const FOO = 1;");
      writeFileSync(join(dir, "code", "beta.ts"), "export function beta() {}\n// TODO: fix");
      writeFileSync(join(dir, "code", "notes.md"), "# Notes\n\nRemember to fix this.");
    });

    it("finds matches across files", async () => {
      const result = await exec({
        action: "grep",
        path: dir,
        pattern: "export function",
        safeMode: false,
      });
      expect(result.success).toBe(true);
      const data = result.data as { matches: Array<{ path: string; line: number; text: string }>; count: number };
      expect(data.count).toBe(2);
    });

    it("restricts by filePattern", async () => {
      const result = await exec({
        action: "grep",
        path: dir,
        pattern: "fix",
        filePattern: "**/*.ts",
        safeMode: false,
      });
      expect(result.success).toBe(true);
      const data = result.data as { matches: Array<{ path: string }>; count: number };
      // Only beta.ts has "fix", notes.md excluded by filePattern
      expect(data.count).toBe(1);
      expect(data.matches[0]!.path).toContain("beta.ts");
    });

    it("is case-insensitive by default", async () => {
      const result = await exec({
        action: "grep",
        path: dir,
        pattern: "todo",
        safeMode: false,
      });
      expect(result.success).toBe(true);
      const data = result.data as { matches: Array<unknown>; count: number };
      expect(data.count).toBeGreaterThan(0);
    });

    it("returns error when pattern missing", async () => {
      const result = await exec({ action: "grep", path: dir, safeMode: false });
      expect(result.success).toBe(false);
      expect(result.error).toContain("pattern required");
    });
  });

  // ── unknown action ────────────────────────────────────────────────────────

  describe("unknown action", () => {
    it("returns error listing valid actions", async () => {
      const result = await exec({ action: "flyaway", path: dir, safeMode: false });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Valid actions");
      expect(result.error).toContain("glob");
    });
  });
});
