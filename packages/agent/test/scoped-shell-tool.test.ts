import { describe, it, expect, vi, afterEach } from "vitest";
import { shellTool } from "@ducki/tools";
import { createScopedShellTool } from "../src/coding/scoped-shell-tool";

/**
 * Regression test: a CodingAgent confined to a sandbox previously left the shell tool's `cwd`
 * defaulting to the server process's own working directory whenever the model omitted it -
 * completely bypassing the filesystem tool's sandbox confinement (a model writing a file via
 * `cat > path <<EOF` instead of the filesystem tool escaped the sandbox entirely, landing in
 * e.g. shared-workspace/ since that's what sits next to the server's cwd).
 */
describe("createScopedShellTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults cwd to the sandbox root when the caller doesn't supply one", async () => {
    const spy = vi.spyOn(shellTool, "execute").mockResolvedValue({ success: true, data: "ok" });
    const tool = createScopedShellTool("/sandbox/my-plugin");

    await tool.execute({ command: "ls" });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "ls", cwd: "/sandbox/my-plugin" }));
  });

  it("respects an explicit cwd supplied by the caller", async () => {
    const spy = vi.spyOn(shellTool, "execute").mockResolvedValue({ success: true, data: "ok" });
    const tool = createScopedShellTool("/sandbox/my-plugin");

    await tool.execute({ command: "npm test", cwd: "/somewhere/else" });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ command: "npm test", cwd: "/somewhere/else" }));
  });

  it("treats a blank cwd string as absent and falls back to the sandbox root", async () => {
    const spy = vi.spyOn(shellTool, "execute").mockResolvedValue({ success: true, data: "ok" });
    const tool = createScopedShellTool("/sandbox/my-plugin");

    await tool.execute({ command: "pwd", cwd: "  " });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/sandbox/my-plugin" }));
  });
});
