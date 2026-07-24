import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { filesystemTool } from "@ducki/tools";

/**
 * Wraps the generic filesystem tool so a CodingAgent confined to a sandbox
 * (e.g. shared-workspace/coding/<project>) defaults every call's basePath to
 * that root, without losing the ability to be called unscoped elsewhere.
 */
export function createScopedFilesystemTool(sandboxRoot: string): ToolExecutor {
  return {
    name: filesystemTool.name,
    description: `${filesystemTool.description} (scoped to ${sandboxRoot})`,
    definition: filesystemTool.definition,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const scopedInput = { ...input };
      if (scopedInput["basePath"] === undefined) {
        scopedInput["basePath"] = sandboxRoot;
      }
      return filesystemTool.execute(scopedInput);
    },
  };
}
