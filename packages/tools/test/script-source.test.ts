import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { frontmatterScript, extractInlineScript, resolveScriptSource, safeRelativePath } from "../src/script-source.ts";

describe("script-source", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ducki-script-source-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("safeRelativePath", () => {
    it("returns a normalized relative path", () => {
      expect(safeRelativePath("./sub/file.js").replaceAll("\\", "/")).toBe("sub/file.js");
    });

    it("rejects a path that traverses outside its base", () => {
      expect(() => safeRelativePath("../escape.js")).toThrow(/traversal/i);
    });
  });

  describe("frontmatterScript", () => {
    it("extracts the script: value from frontmatter", () => {
      const content = ["---", "name: demo", "script: custom.js", "---", "", "body"].join("\n");
      expect(frontmatterScript(content)).toBe("custom.js");
    });

    it("returns undefined when there is no frontmatter block", () => {
      expect(frontmatterScript("# just a heading")).toBeUndefined();
    });
  });

  describe("extractInlineScript", () => {
    it("extracts a closed <script> block", () => {
      const content = "before\n<script>\nconsole.log(1);\n</script>\nafter";
      expect(extractInlineScript(content)).toBe("console.log(1);");
    });

    it("extracts an unclosed <script> block to end of file", () => {
      const content = "before\n<script>\nreturn 1;";
      expect(extractInlineScript(content)).toBe("return 1;");
    });

    it("returns undefined when there is no script tag", () => {
      expect(extractInlineScript("no script here")).toBeUndefined();
    });
  });

  describe("resolveScriptSource fallback chain", () => {
    it("prefers an explicit relative path over everything else", () => {
      writeFileSync(join(dir, "explicit.js"), "return 'explicit';", "utf8");
      writeFileSync(join(dir, "script.js"), "return 'default';", "utf8");
      const content = ["---", "script: other.js", "---", "<script>return 'inline';</script>"].join("\n");

      const result = resolveScriptSource(dir, content, { explicitRelativePath: "explicit.js" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source).toBe("explicit.js");
        expect(result.script).toBe("return 'explicit';");
      }
    });

    it("falls back to the frontmatter script: path when no explicit path is given", () => {
      writeFileSync(join(dir, "custom.js"), "return 'from-frontmatter';", "utf8");
      const content = ["---", "script: custom.js", "---", ""].join("\n");

      const result = resolveScriptSource(dir, content);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source).toBe("custom.js");
        expect(result.script).toBe("return 'from-frontmatter';");
      }
    });

    it("falls back to a sibling script.js when there is no frontmatter script:", () => {
      writeFileSync(join(dir, "script.js"), "return 'from-script-js';", "utf8");
      const content = ["---", "name: demo", "---", ""].join("\n");

      const result = resolveScriptSource(dir, content);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source).toBe("script.js");
        expect(result.script).toBe("return 'from-script-js';");
      }
    });

    it("falls back to an inline <script> block when nothing else resolves", () => {
      const content = ["---", "name: demo", "---", "<script>return 'inline';</script>"].join("\n");

      const result = resolveScriptSource(dir, content);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source).toBe("inline:<script>");
        expect(result.script).toBe("return 'inline';");
      }
    });

    it("fails clearly when nothing resolves", () => {
      const content = ["---", "name: demo", "---", "no script here"].join("\n");
      const result = resolveScriptSource(dir, content);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/no executable script/i);
      }
    });

    it("rejects a frontmatter script: path that escapes the directory", () => {
      const content = ["---", "script: ../../escape.js", "---", ""].join("\n");
      const result = resolveScriptSource(dir, content);
      expect(result.ok).toBe(false);
    });

    it("reports a missing configured script file distinctly", () => {
      const content = ["---", "script: does-not-exist.js", "---", ""].join("\n");
      const result = resolveScriptSource(dir, content);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/not found/i);
      }
    });
  });
});
