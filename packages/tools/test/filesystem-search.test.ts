import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globFiles, grepFiles, globToRegex } from "../src/filesystem-search.ts";

describe("filesystem-search (PR3)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ducki-fs-search-"));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "src", "utils"));
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "src", "index.ts"), 'export const APP = "ducki";\n// main entry');
    writeFileSync(join(dir, "src", "utils", "helper.ts"), "export function add(a: number, b: number) { return a + b; }");
    writeFileSync(join(dir, "src", "utils", "format.js"), 'export const fmt = (s) => s.trim();');
    writeFileSync(join(dir, "dist", "bundle.js"), "!function(){}()");
    writeFileSync(join(dir, "README.md"), "# Ducki\n\nThis is the readme.");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── globToRegex ────────────────────────────────────────────────────────────

  describe("globToRegex", () => {
    it("matches ** across path segments", () => {
      const re = globToRegex("**/*.ts");
      expect(re.test("src/index.ts")).toBe(true);
      expect(re.test("src/utils/helper.ts")).toBe(true);
      expect(re.test("src/utils/format.js")).toBe(false);
    });

    it("matches * within a single segment", () => {
      const re = globToRegex("*.ts");
      expect(re.test("index.ts")).toBe(true);
      expect(re.test("src/index.ts")).toBe(false);
    });

    it("matches ? for a single character", () => {
      const re = globToRegex("file?.ts");
      expect(re.test("fileA.ts")).toBe(true);
      expect(re.test("fileAB.ts")).toBe(false);
    });

    it("matches {a,b} alternatives", () => {
      const re = globToRegex("**/*.{ts,js}");
      expect(re.test("src/index.ts")).toBe(true);
      expect(re.test("src/utils/format.js")).toBe(true);
      expect(re.test("README.md")).toBe(false);
    });

    it("escapes regex special chars in literal parts", () => {
      const re = globToRegex("file.txt");
      expect(re.test("filetxt")).toBe(false); // . is literal not wildcard
      expect(re.test("file.txt")).toBe(true);
    });
  });

  // ── globFiles ─────────────────────────────────────────────────────────────

  describe("globFiles", () => {
    it("finds all .ts files recursively", () => {
      const results = globFiles(dir, "**/*.ts");
      expect(results).toHaveLength(2);
      expect(results.some((p) => p.endsWith("index.ts"))).toBe(true);
      expect(results.some((p) => p.endsWith("helper.ts"))).toBe(true);
    });

    it("finds .js files recursively", () => {
      const results = globFiles(dir, "**/*.js");
      expect(results).toHaveLength(2);
    });

    it("finds only root-level files with *.md", () => {
      const results = globFiles(dir, "*.md");
      expect(results).toHaveLength(1);
      expect(results[0]).toContain("README.md");
    });

    it("respects maxResults limit", () => {
      const results = globFiles(dir, "**/*", { maxResults: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("returns empty array for non-existent root", () => {
      const results = globFiles("/nonexistent/path", "**/*.ts");
      expect(results).toHaveLength(0);
    });

    it("returns empty array when no files match", () => {
      const results = globFiles(dir, "**/*.xyz");
      expect(results).toHaveLength(0);
    });
  });

  // ── grepFiles ─────────────────────────────────────────────────────────────

  describe("grepFiles", () => {
    it("finds pattern across all files", () => {
      const results = grepFiles(dir, "export");
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((m) => m.text.toLowerCase().includes("export"))).toBe(true);
    });

    it("includes file path, line number, and text", () => {
      const results = grepFiles(dir, "ducki");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty("path");
      expect(results[0]).toHaveProperty("line");
      expect(results[0]).toHaveProperty("text");
      expect(results[0]!.line).toBeGreaterThan(0);
    });

    it("restricts search by filePattern", () => {
      const results = grepFiles(dir, "export", { filePattern: "**/*.ts" });
      expect(results.every((m) => m.path.endsWith(".ts"))).toBe(true);
    });

    it("is case-insensitive by default", () => {
      const lower = grepFiles(dir, "ducki");
      const upper = grepFiles(dir, "DUCKI");
      expect(lower.length).toBe(upper.length);
    });

    it("respects caseSensitive:true", () => {
      const sensitive = grepFiles(dir, "DUCKI", { caseSensitive: true });
      const insensitive = grepFiles(dir, "DUCKI", { caseSensitive: false });
      expect(sensitive.length).toBe(0);
      expect(insensitive.length).toBeGreaterThan(0);
    });

    it("respects maxResults limit", () => {
      const results = grepFiles(dir, ".", { maxResults: 2 }); // . matches every line
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("returns empty array for non-existent root", () => {
      const results = grepFiles("/no/such/path", "anything");
      expect(results).toHaveLength(0);
    });
  });
});
