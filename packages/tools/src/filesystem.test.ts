import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Explicit ".ts" on purpose: a stale compiled `src/filesystem.js` sits next to the
// source, and Vite resolves ".js" before ".ts" - both "./filesystem.js" and the
// extensionless form would load that week-old artifact instead of this file's subject.
import { filesystemTool } from "./filesystem.ts";

/**
 * Directory/file confusion used to escape as raw Node errnos ("EISDIR: illegal operation
 * on a directory, read"), which gave the agent no idea which action to use instead.
 */
describe("filesystem tool - directory vs file handling", () => {
  let root: string;

  const run = (input: Record<string, unknown>) =>
    filesystemTool.execute({ safeMode: false, ...input });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ducki-fs-"));
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "hello", "utf8");
    writeFileSync(join(root, "sub", "b.txt"), "world", "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("read on a directory lists it instead of throwing EISDIR", async () => {
    const result = await run({ action: "read", path: root });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data["isDirectory"]).toBe(true);
    expect(data["count"]).toBe(2);
    expect(String(data["note"])).toContain('action:"list"');
    const names = (data["entries"] as Array<{ name: string }>).map((e) => e.name).sort();
    expect(names).toEqual(["a.txt", "sub"]);
  });

  it("read returns file content with line numbers", async () => {
    const result = await run({ action: "read", path: join(root, "a.txt") });
    expect(result.success).toBe(true);
    expect(result.data).toBe("1: hello");
  });

  it("read reports a missing path as not found", async () => {
    const result = await run({ action: "read", path: join(root, "nope.txt") });
    expect(result.success).toBe(false);
    expect(result.error).toContain("File not found");
  });

  it("list on a file explains to use read", async () => {
    const result = await run({ action: "list", path: join(root, "a.txt") });
    expect(result.success).toBe(false);
    expect(result.error).toContain('action:"read"');
  });

  it("edit on a directory fails with an actionable message", async () => {
    const result = await run({ action: "edit", path: root, oldString: "a", newString: "b" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("is a directory");
    expect(result.error).not.toContain("EISDIR");
  });

  it("append on a directory fails with an actionable message", async () => {
    const result = await run({ action: "append", path: root, content: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("is a directory");
  });

  it("copy on a directory fails with an actionable message", async () => {
    const result = await run({ action: "copy", path: root, destination: join(root, "clone") });
    expect(result.success).toBe(false);
    expect(result.error).toContain("is a directory");
  });

  it("delete on a directory demands recursive instead of throwing", async () => {
    const result = await run({ action: "delete", path: join(root, "sub") });
    expect(result.success).toBe(false);
    expect(result.error).toContain("recursive:true");

    const recursive = await run({ action: "delete", path: join(root, "sub"), recursive: true });
    expect(recursive.success).toBe(true);
  });

  /**
   * Regression: an empty path used to join onto the base as a no-op, so every action
   * silently operated on the BASE ITSELF (basePath, or the shared workspace root) instead
   * of failing with a clear message. A write there crashed with a cryptic
   * "EPERM: operation not permitted, copyfile <base> -> <base>.bak" while trying to
   * atomic-write over the whole directory, instead of the real problem: no path was given.
   */
  it("an empty path is rejected instead of resolving to the base directory", async () => {
    const result = await run({ action: "write", path: "", content: "oops", basePath: root });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/path is required/i);
  });
});

/**
 * Regression: content taken verbatim from a heredoc write block (or a native tool_call whose
 * arguments never passed through a hand-written JSON string) is marked __contentTrusted so the
 * caller can skip the leak-stripping heuristics. The tool's own \n\t\r de-escape used to run
 * UNCONDITIONALLY regardless of that flag, corrupting real code that legitimately contains a
 * literal `\n`/`\t`/`\r` two-character sequence (a JS string, a regex, documentation about
 * escape sequences) by turning it into an actual control character.
 */
describe("filesystem tool - __contentTrusted content is never re-escaped", () => {
  let root: string;
  const run = (input: Record<string, unknown>) =>
    filesystemTool.execute({ safeMode: false, ...input });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ducki-fs-trusted-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves literal \\n sequences alone for trusted content", async () => {
    const literal = 'console.log("line one\\nline two");';
    const path = join(root, "script.js");
    const result = await run({ action: "write", path, content: literal, __contentTrusted: true });

    expect(result.success).toBe(true);
    const read = await run({ action: "read", path, raw: true });
    expect(read.data).toBe(literal);
  });

  it("still de-escapes \\n for untrusted (JSON-sourced) content", async () => {
    const path = join(root, "note.txt");
    const result = await run({ action: "write", path, content: "line one\\nline two" });

    expect(result.success).toBe(true);
    const read = await run({ action: "read", path, raw: true });
    expect(read.data).toBe("line one\nline two");
  });

  it("does not leak the internal __contentTrusted flag into the result", async () => {
    const path = join(root, "a.txt");
    const result = await run({ action: "write", path, content: "hi", __contentTrusted: true });
    expect(JSON.stringify(result)).not.toContain("__contentTrusted");
  });
});
