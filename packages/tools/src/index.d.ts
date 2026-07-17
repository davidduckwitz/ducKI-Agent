import type { ToolExecutor } from "@ducki/shared";
import { filesystemTool } from "./filesystem.js";
import { httpTool } from "./http.js";
import { gitTool } from "./git.js";
import { shellTool } from "./shell.js";
export { filesystemTool, httpTool, gitTool, shellTool };
export declare const allTools: ToolExecutor[];
export declare function getToolByName(name: string): ToolExecutor | undefined;
//# sourceMappingURL=index.d.ts.map