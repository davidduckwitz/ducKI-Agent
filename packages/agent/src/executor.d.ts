import type { ToolDefinition, ToolResult, ToolExecutor } from "@ducki/shared";
import type { Logger } from "@ducki/logger";
export declare class Executor {
    private readonly logger;
    private tools;
    constructor(logger: Logger);
    registerTool(tool: ToolExecutor): void;
    unregisterTool(name: string): void;
    hasTool(name: string): boolean;
    getToolDefinitions(): ToolDefinition[];
    execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult>;
    listTools(): {
        name: string;
        description: string;
    }[];
}
//# sourceMappingURL=executor.d.ts.map