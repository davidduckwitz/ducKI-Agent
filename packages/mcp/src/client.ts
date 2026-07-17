import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MCPClient {
  private tools = new Map<string, MCPTool>();
  private logger: Logger;
  private connected = false;
  private stopping = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly serverId: string,
    private readonly serverUrl: string,
    private readonly options: MCPClientOptions = {}
  ) {
    this.logger = getRootLogger().child(`MCPClient:${serverId}`);
  }

  private get reconnectBaseMs(): number {
    return Math.max(250, Number(this.options.reconnectBaseMs ?? 750));
  }

  private get reconnectMaxMs(): number {
    return Math.max(this.reconnectBaseMs, Number(this.options.reconnectMaxMs ?? 15000));
  }

  private get toolsRefreshMs(): number {
    return Math.max(1000, Number(this.options.toolsRefreshMs ?? 15000));
  }

  private async fetchTools(): Promise<MCPTool[]> {
    const response = await fetch(`${this.serverUrl}/tools`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { tools?: MCPTool[] };
    return Array.isArray(data.tools) ? data.tools : [];
  }

  private applyTools(tools: MCPTool[]): void {
    this.tools.clear();
    for (const tool of tools) {
      this.tools.set(tool.name, { ...tool, serverId: this.serverId });
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(async () => {
      if (this.stopping) return;
      try {
        const tools = await this.fetchTools();
        this.applyTools(tools);
        if (!this.connected) {
          this.connected = true;
          this.reconnectAttempts = 0;
        }
      } catch (error) {
        this.connected = false;
        this.logger.warn("MCP tools refresh failed", {
          url: this.serverUrl,
          error: error instanceof Error ? error.message : String(error),
        });
        void this.ensureReconnect();
      }
    }, this.toolsRefreshMs);
  }

  private async ensureReconnect(): Promise<void> {
    if (this.reconnecting || this.stopping || this.connected) return;
    this.reconnecting = true;
    try {
      while (!this.stopping && !this.connected) {
        this.reconnectAttempts += 1;
        const delay = Math.min(this.reconnectBaseMs * 2 ** (this.reconnectAttempts - 1), this.reconnectMaxMs);
        await sleep(delay);
        if (this.stopping) break;
        try {
          const tools = await this.fetchTools();
          this.applyTools(tools);
          this.connected = true;
          this.reconnectAttempts = 0;
          this.logger.info("MCP reconnected", { url: this.serverUrl, tools: this.tools.size });
        } catch (error) {
          this.connected = false;
          this.logger.warn("MCP reconnect attempt failed", {
            url: this.serverUrl,
            attempt: this.reconnectAttempts,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  async connect(): Promise<void> {
    this.stopping = false;
    try {
      const tools = await this.fetchTools();
      this.applyTools(tools);
      this.connected = true;
      this.reconnectAttempts = 0;
      this.logger.info("MCP connected", { url: this.serverUrl, tools: this.tools.size });
    } catch (error) {
      this.connected = false;
      this.logger.warn("MCP initial connect failed", {
        url: this.serverUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      void this.ensureReconnect();
    }
    this.scheduleRefresh();
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    this.connected = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    try {
      const response = await fetch(`${this.serverUrl}/tools/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      if (!response.ok) {
        return { success: false, data: null, error: `HTTP ${response.status}` };
      }

      const result = (await response.json()) as ToolResult;
      return result;
    } catch (error) {
      this.connected = false;
      void this.ensureReconnect();
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async *streamTool(name: string, input: Record<string, unknown>): AsyncGenerator<string> {
    const response = await fetch(`${this.serverUrl}/tools/${name}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error("MCP stream response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const lines = part
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          yield line.slice(5).trim();
        }
      }
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }

  listTools(): MCPTool[] {
    return Array.from(this.tools.values());
  }
}
