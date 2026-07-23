import type { ToolExecutor } from "@ducki/shared";
import { filesystemTool } from "./filesystem.js";
import { httpTool } from "./http.js";
import { gitTool } from "./git.js";
import { browserTool } from "./browser.js";
import { shellTool } from "./shell.js";
import { skillsTool } from "./skills.js";
export { filesystemTool, httpTool, gitTool, browserTool, shellTool, skillsTool };
export declare const allTools: ToolExecutor[];
export declare function getToolByName(name: string): ToolExecutor | undefined;
//# sourceMappingURL=index.d.ts.map