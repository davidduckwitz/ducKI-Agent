import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import type { ToolDefinition, ToolResult } from "@ducki/shared";
import { MCPClient, type MCPClientOptions, type MCPTool } from "./client.js";

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

export class MCPRegistry {
  private clients = new Map<string, MCPClient>();
  private configs = new Map<string, MCPServerConfig>();
  private logger: Logger;

  constructor(private readonly clientOptions: MCPClientOptions = {}) {
    this.logger = getRootLogger().child("MCPRegistry");
  }

  async registerServer(config: MCPServerConfig): Promise<void> {
    const normalized: MCPServerConfig = {
      id: String(config.id).trim(),
      name: String(config.name).trim(),
      url: String(config.url).trim(),
      enabled: Boolean(config.enabled),
    };

    if (!normalized.id || !normalized.name || !normalized.url) {
      throw new Error("MCP server config requires id, name, and url");
    }

    this.configs.set(normalized.id, normalized);

    await this.unregisterServer(normalized.id);

    if (!normalized.enabled) {
      this.logger.info("MCP server stored as disabled", { id: normalized.id, name: normalized.name });
      return;
    }

    const client = new MCPClient(normalized.id, normalized.url, this.clientOptions);
    await client.connect();
    this.clients.set(normalized.id, client);
    this.logger.info("MCP server registered", { id: normalized.id, name: normalized.name, url: normalized.url });
  }

  async syncServers(configs: MCPServerConfig[]): Promise<void> {
    const nextIds = new Set(configs.map((cfg) => String(cfg.id).trim()));

    for (const existingId of Array.from(this.configs.keys())) {
      if (nextIds.has(existingId)) continue;
      await this.unregisterServer(existingId);
      this.configs.delete(existingId);
    }

    for (const config of configs) {
      await this.registerServer(config);
    }
  }

  async unregisterServer(id: string): Promise<void> {
    const normalizedId = String(id).trim();
    const client = this.clients.get(normalizedId);
    if (client) {
      await client.disconnect();
      this.clients.delete(normalizedId);
    }
  }

  getServerStatus(): MCPServerStatus[] {
    return Array.from(this.configs.values())
      .map((config) => {
        const client = this.clients.get(config.id);
        return {
          ...config,
          connected: client?.isConnected() ?? false,
          reconnectAttempts: client?.getReconnectAttempts() ?? 0,
          tools: client?.listTools().length ?? 0,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  listTools(): Array<MCPTool & { serverId: string }> {
    const result: Array<MCPTool & { serverId: string }> = [];
    for (const [serverId, client] of this.clients.entries()) {
      for (const tool of client.listTools()) {
        result.push({ ...tool, serverId });
      }
    }
    return result;
  }

  getAllTools(): ToolDefinition[] {
    const all: ToolDefinition[] = [];
    for (const client of this.clients.values()) {
      all.push(...client.getToolDefinitions());
    }
    return all;
  }

  async callTool(toolName: string, input: Record<string, unknown>, serverId?: string): Promise<ToolResult> {
    if (serverId) {
      const targeted = this.clients.get(serverId);
      if (!targeted) {
        return { success: false, data: null, error: `MCP server '${serverId}' not available` };
      }
      return targeted.callTool(toolName, input);
    }

    for (const client of this.clients.values()) {
      const tools = client.listTools();
      if (tools.some((tool) => tool.name === toolName)) {
        return client.callTool(toolName, input);
      }
    }
    return { success: false, data: null, error: `Tool '${toolName}' not found in any MCP server` };
  }

  async *streamTool(toolName: string, input: Record<string, unknown>, serverId?: string): AsyncGenerator<string> {
    if (serverId) {
      const targeted = this.clients.get(serverId);
      if (!targeted) throw new Error(`MCP server '${serverId}' not available`);
      yield* targeted.streamTool(toolName, input);
      return;
    }

    for (const client of this.clients.values()) {
      const tools = client.listTools();
      if (!tools.some((tool) => tool.name === toolName)) continue;
      yield* client.streamTool(toolName, input);
      return;
    }

    throw new Error(`Tool '${toolName}' not found in any MCP server`);
  }

  async shutdown(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect();
    }
    this.clients.clear();
  }
}
