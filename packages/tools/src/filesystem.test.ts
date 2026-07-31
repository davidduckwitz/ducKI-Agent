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

  it("read still returns file content unchanged", async () => {
    const result = await run({ action: "read", path: join(root, "a.txt") });
    expect(result.success).toBe(true);
    expect(result.data).toBe("hello");
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
});
