import type { ToolDefinition, ToolResult } from "@ducki/shared";
import { type MCPClientOptions, type MCPTool } from "./client.js";
export interface MCPServerConfig {
    id: string;
    name: string;
    url: string;
    enabled: boolean;
}
export interface MCPServerStatus extends MCPServerConfig {
    connected: boolean;
    reconnectAttempts: number;
    tools: number;
}
export declare class MCPRegistry {
    private readonly clientOptions;
    private clients;
    private configs;
    private logger;
    constructor(clientOptions?: MCPClientOptions);
    registerServer(config: MCPServerConfig): Promise<void>;
    syncServers(configs: MCPServerConfig[]): Promise<void>;
    unregisterServer(id: string): Promise<void>;
    getServerStatus(): MCPServerStatus[];
    listTools(): Array<MCPTool & {
        serverId: string;
    }>;
    getAllTools(): ToolDefinition[];
    callTool(toolName: string, input: Record<string, unknown>, serverId?: string): Promise<ToolResult>;
    streamTool(toolName: string, input: Record<string, unknown>, serverId?: string): AsyncGenerator<string>;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=registry.d.ts.map