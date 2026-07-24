import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { filesystemTool } from "@ducki/tools";

/**
 * Wraps the generic filesystem tool so a CodingAgent confined to a sandbox
 * (e.g. shared-workspace/coding/<project>) is hard-locked to that root.
 * basePath and safeMode are always forced here, overriding whatever the LLM
 * supplies in its own tool call - otherwise the model could pass its own
 * basePath or safeMode:false and escape the sandbox entirely.
 */
export function createScopedFilesystemTool(sandboxRoot: string): ToolExecutor {
  return {
    name: filesystemTool.name,
    description: `${filesystemTool.description} (scoped to ${sandboxRoot})`,
    definition: filesystemTool.definition,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const scopedInput = { ...input, basePath: sandboxRoot, safeMode: true };
      return filesystemTool.execute(scopedInput);
    },
  };
}
