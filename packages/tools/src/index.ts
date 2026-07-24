import type { ToolExecutor } from "@ducki/shared";
import { filesystemTool } from "./filesystem.js";
import { httpTool } from "./http.js";
import { gitTool } from "./git.js";
import { browserTool } from "./browser.js";
import { shellTool } from "./shell.js";
import { skillsTool } from "./skills.js";

export { filesystemTool, httpTool, gitTool, browserTool, shellTool, skillsTool };
export { runScriptInSandbox, sanitizeRuntimeValue } from "./sandbox.js";
export type { SandboxRuntime, SandboxVarNames, SandboxExecutionResult } from "./sandbox.js";

export const allTools: ToolExecutor[] = [filesystemTool, httpTool, gitTool, browserTool, shellTool, skillsTool];

export function getToolByName(name: string): ToolExecutor | undefined {
  return allTools.find((t) => t.name === name);
}
