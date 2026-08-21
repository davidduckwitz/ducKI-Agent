import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractFileContent, filesystemTool } from "../src/index.ts";

/**
 * Regression coverage for `filesystem:write requires string field 'content'` - a write that
 * failed ten times in a row and killed the run, for a file that was perfectly writable.
 *
 * The tool accepted nine alias names for the body; the agent's preflight demanded a literal
 * string in `content` and rejected the call before the tool ever saw it. Both now share this
 * one extractor, so they cannot disagree again.
 */
describe("extractFileContent", () => {
  it("accepts every alias a model reaches for", () => {
    for (const field of [
      "content",
      "contents",
      "text",
      "file_text",
      "fileText",
      "fileContent",
      "file_contents",
      "data",
      "body",
    ]) {
      expect(extractFileContent({ [field]: "hello" }), field).toBe("hello");
    }
  });

  it("prefers the canonical field when several are present", () => {
    expect(extractFileContent({ content: "right", text: "wrong" })).toBe("right");
  });

  it("joins an array of lines", () => {
    expect(extractFileContent({ content: ["a", "b", "c"] })).toBe("a\nb\nc");
  });

  it("stringifies a number or boolean", () => {
    expect(extractFileContent({ content: 42 })).toBe("42");
    expect(extractFileContent({ content: true })).toBe("true");
  });

  it("serialises an object only for a JSON target", () => {
    // Writing JSON into a .ts file would be a silent corruption - a clear error beats a guess.
    expect(extractFileContent({ content: { a: 1 } }, "config.json")).toBe('{\n  "a": 1\n}');
    expect(extractFileContent({ content: { a: 1 } }, "src/app.ts")).toBeUndefined();
  });

  it("keeps an empty string, which is a legitimate file body", () => {
    expect(extractFileContent({ content: "" })).toBe("");
  });

  it("skips null and undefined and keeps looking", () => {
    expect(extractFileContent({ content: null, text: "fallback" })).toBe("fallback");
    expect(extractFileContent({ content: undefined, body: "fallback" })).toBe("fallback");
  });

  it("returns undefined when there is genuinely no body", () => {
    expect(extractFileContent({ action: "write", path: "a.txt" })).toBeUndefined();
  });
});

describe("filesystem write with aliased content", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ducki-write-alias-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a file whose body arrived as file_text", async () => {
    const result = await filesystemTool.execute({
      action: "write",
      path: "doc.md",
      file_text: "# Titel\n\nText.",
      basePath: dir,
      safeMode: true,
    });

    expect(result.success).toBe(true);
    expect(readFileSync(join(dir, "doc.md"), "utf8")).toBe("# Titel\n\nText.");
  });

  it("writes a file whose body arrived as an array of lines", async () => {
    const result = await filesystemTool.execute({
      action: "write",
      path: "lines.txt",
      content: ["erste", "zweite"],
      basePath: dir,
      safeMode: true,
    });

    expect(result.success).toBe(true);
    expect(readFileSync(join(dir, "lines.txt"), "utf8")).toBe("erste\nzweite");
  });

  it("still refuses a write that carries no body at all", async () => {
    const result = await filesystemTool.execute({
      action: "write",
      path: "empty.txt",
      basePath: dir,
      safeMode: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Content required");
  });
});
