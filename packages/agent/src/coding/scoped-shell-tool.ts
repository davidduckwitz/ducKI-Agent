import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { shellTool } from "@ducki/tools";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Wraps the generic shell tool so a CodingAgent confined to a sandbox cannot
 * escape that sandbox by supplying its own working directory.
 *
 * Both the sandbox root and requested cwd are canonicalised with realpathSync,
 * so an in-sandbox symlink that points outside the root is rejected too. A
 * relative cwd is resolved from the sandbox root; an omitted/blank cwd uses the
 * root itself. The underlying shell tool is never called for an invalid cwd.
 *
 * This is a workspace boundary, not a complete process sandbox: an allowed
 * executable can still have capabilities of its own. Command-level approval
 * policies remain responsible for deciding which executables/actions may run.
 */
export function createScopedShellTool(sandboxRoot: string): ToolExecutor {
  const canonicalRoot = realpathSync(resolve(sandboxRoot));

  return {
    name: shellTool.name,
    description: `${shellTool.description} (working directory is confined to ${canonicalRoot})`,
    definition: shellTool.definition,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const scopedInput: Record<string, unknown> = { ...input };
      const suppliedCwd = typeof scopedInput["cwd"] === "string" ? scopedInput["cwd"].trim() : "";
      const requestedPath = suppliedCwd === "" ? canonicalRoot : resolve(canonicalRoot, suppliedCwd);

      let canonicalCwd: string;
      try {
        canonicalCwd = realpathSync(requestedPath);
      } catch {
        return {
          success: false,
          error: `Shell cwd does not exist or cannot be resolved: ${requestedPath}`,
        };
      }

      if (!isPathInside(canonicalRoot, canonicalCwd)) {
        return {
          success: false,
          error: `Shell cwd is outside the coding sandbox: ${canonicalCwd}`,
        };
      }

      scopedInput["cwd"] = canonicalCwd;
      return shellTool.execute(scopedInput);
    },
  };
}
