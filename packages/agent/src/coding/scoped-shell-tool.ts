import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { shellTool } from "@ducki/tools";

/**
 * Wraps the generic shell tool so a CodingAgent confined to a sandbox defaults every command's
 * working directory to that sandbox, instead of the server process's own cwd.
 *
 * Unlike the filesystem tool, shellTool has no basePath/safeMode concept at all - it just runs
 * `cwd: input.cwd ?? process.cwd()`. CodingAgent only ever set `cwd` explicitly for its OWN
 * deterministic verify-command execution; a model-initiated shell call (e.g. writing a file via
 * `cat > path <<EOF` instead of the filesystem tool) silently defaulted to the server's cwd
 * (apps/server), landing in whatever real directory happens to sit there - e.g. shared-workspace/
 * - completely bypassing the filesystem tool's sandbox confinement.
 *
 * A model-supplied `cwd` is still respected (some legitimate commands need to look outside the
 * sandbox, e.g. a monorepo-root npm/git command) - only the previously-useless default changes.
 */
export function createScopedShellTool(sandboxRoot: string): ToolExecutor {
  return {
    name: shellTool.name,
    description: `${shellTool.description} (defaults to working directory ${sandboxRoot} unless cwd is given)`,
    definition: shellTool.definition,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const scopedInput: Record<string, unknown> = { ...input };
      if (typeof scopedInput["cwd"] !== "string" || scopedInput["cwd"].trim() === "") {
        scopedInput["cwd"] = sandboxRoot;
      }
      return shellTool.execute(scopedInput);
    },
  };
}
