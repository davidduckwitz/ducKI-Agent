import type { ToolDefinition, ToolResult } from "@ducki/shared";
export interface MCPTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    serverId?: string;
}
export interface MCPClientOptions {
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    toolsRefreshMs?: number;
}
export declare class MCPClient {
    private readonly serverId;
    private readonly serverUrl;
    private readonly options;
    private tools;
    private logger;
    private connected;
    private stopping;
    private reconnecting;
    private reconnectAttempts;
    private refreshTimer;
    constructor(serverId: string, serverUrl: string, options?: MCPClientOptions);
    private get reconnectBaseMs();
    private get reconnectMaxMs();
    private get toolsRefreshMs();
    private fetchTools;
    private applyTools;
    private scheduleRefresh;
    private ensureReconnect;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    isConnected(): boolean;
    getReconnectAttempts(): number;
    callTool(name: string, input: Record<string, unknown>): Promise<ToolResult>;
    streamTool(name: string, input: Record<string, unknown>): AsyncGenerator<string>;
    getToolDefinitions(): ToolDefinition[];
    listTools(): MCPTool[];
}
//# sourceMappingURL=client.d.ts.map