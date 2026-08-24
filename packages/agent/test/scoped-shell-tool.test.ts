import { describe, it, expect, vi, afterEach } from "vitest";
import { shellTool } from "@ducki/tools";
import { createScopedShellTool } from "../src/coding/scoped-shell-tool";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("createScopedShellTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults cwd to the sandbox root when the caller doesn't supply one", async () => {
    const root = makeTempRoot("ducki-shell-root-");
    const spy = vi.spyOn(shellTool, "execute").mockResolvedValue({ success: true, data: "ok" });
    const tool = createScopedShellTool(root);

    await tool.execute({ command: "ls" });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "ls", cwd: realpathSync(root) }));
  });

  it("allows an explicit cwd inside the sandbox", async () => {
    const root = makeTempRoot("ducki-shell-root-");
    const child = join(root, "packages", "agent");
    mkdirSync(child, { recursive: true });
    const spy = vi.spyOn(shellTool, "execute").mockResolvedValue({ success: true, data: "ok" });
    const tool = createScopedShellTool(root);

    await tool.execute({ command: "npm test", cwd: child });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "npm test", cwd: realpathSync(child) }));
  });

  it("resolves a relative cwd from the sandbox root", async () => {
    const root = makeTempRoot("ducki-shell-root-");
    const child = join(root, "subdir");
    mkdirSync(child);
    const spy = vi.spyOn(shellTool, "execute").mockResolvedValue({ success: true, data: "ok" });
    const tool = createScopedShellTool(root);

    await tool.execute({ command: "pwd", cwd: "subdir" });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ cwd: realpathSync(child) }));
  });

  it("rejects an explicit cwd outside the sandbox without invoking shellTool", async () => {
    const root = makeTempRoot("ducki-shell-root-");
    const outside = makeTempRoot("ducki-shell-outside-");
    const spy = vi.spyOn(shellTool, "execute").mockResolvedValue({ success: true, data: "ok" });
    const tool = createScopedShellTool(root);

    const result = await tool.execute({ command: "npm test", cwd: outside });

    expect(result.success).toBe(false);
    expect(result.error).toContain("outside the coding sandbox");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects parent traversal that escapes the sandbox", async () => {
    const parent = makeTempRoot("ducki-shell-parent-");
    const root = join(parent, "sandbox");
    mkdirSync(root);
    const outside = join(parent, "outside");
    mkdirSync(outside);
    const spy = vi.spyOn(shellTool, "execute").mockResolvedValue({ success: true, data: "ok" });
    const tool = createScopedShellTool(root);

    const result = await tool.execute({ command: "pwd", cwd: "../outside" });

    expect(result.success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("treats a blank cwd string as absent and falls back to the sandbox root", async () => {
    const root = makeTempRoot("ducki-shell-root-");
    const spy = vi.spyOn(shellTool, "execute").mockResolvedValue({ success: true, data: "ok" });
    const tool = createScopedShellTool(root);

    await tool.execute({ command: "pwd", cwd: "  " });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ cwd: realpathSync(root) }));
  });
});
