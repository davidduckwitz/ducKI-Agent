import type { ToolResult } from "@ducki/shared";
export interface MCPToolHandler {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}
export interface MCPServerSnapshot {
    tools: Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
    }>;
}
export declare class MCPServer {
    private tools;
    registerTool(handler: MCPToolHandler): void;
    unregisterTool(name: string): void;
    listTools(): MCPServerSnapshot;
    callTool(name: string, input: Record<string, unknown>): Promise<ToolResult>;
}
//# sourceMappingURL=server.d.ts.map