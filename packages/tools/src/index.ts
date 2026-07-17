import type { ToolExecutor } from "@ducki/shared";
import { filesystemTool } from "./filesystem.js";
import { httpTool } from "./http.js";
import { gitTool } from "./git.js";
import { shellTool } from "./shell.js";
import { skillsTool } from "./skills.js";

export { filesystemTool, httpTool, gitTool, shellTool, skillsTool };

export const allTools: ToolExecutor[] = [filesystemTool, httpTool, gitTool, shellTool, skillsTool];

export function getToolByName(name: string): ToolExecutor | undefined {
  return allTools.find((t) => t.name === name);
}
