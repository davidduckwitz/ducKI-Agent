import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import type { ToolDefinition, ToolResult } from "@ducki/shared";

export interface MCPServerConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
}

export class MCPClient {
  private tools = new Map<string, MCPTool>();
  private logger: Logger;

  constructor(private readonly serverUrl: string) {
    this.logger = getRootLogger().child("MCPClient");
  }

  async connect(): Promise<void> {
    try {
      const response = await fetch(`${this.serverUrl}/tools`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json() as { tools: MCPTool[] };
      for (const tool of data.tools ?? []) {
        this.tools.set(tool.name, tool);
      }

      this.logger.info("MCP connected", { url: this.serverUrl, tools: this.tools.size });
    } catch (error) {
      this.logger.warn("MCP connection failed", {
        url: this.serverUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

      const result = await response.json() as ToolResult;
      return result;
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }

  listTools(): MCPTool[] {
    return Array.from(this.tools.values());
  }
}

export class MCPRegistry {
  private clients = new Map<string, MCPClient>();
  private logger: Logger;

  constructor() {
    this.logger = getRootLogger().child("MCPRegistry");
  }

  async registerServer(config: MCPServerConfig): Promise<void> {
    const client = new MCPClient(config.url);
    await client.connect();
    this.clients.set(config.id, client);
    this.logger.info("MCP server registered", { id: config.id, name: config.name });
  }

  unregisterServer(id: string): void {
    this.clients.delete(id);
  }

  async callTool(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
    for (const client of this.clients.values()) {
      const tools = client.listTools();
      if (tools.some((t) => t.name === toolName)) {
        return client.callTool(toolName, input);
      }
    }
    return { success: false, data: null, error: `Tool '${toolName}' not found in any MCP server` };
  }

  getAllTools(): ToolDefinition[] {
    const all: ToolDefinition[] = [];
    for (const client of this.clients.values()) {
      all.push(...client.getToolDefinitions());
    }
    return all;
  }
}
