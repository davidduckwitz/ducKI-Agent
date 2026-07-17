import type { ToolResult } from "@ducki/shared";

export interface MCPToolHandler {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}

export interface MCPServerSnapshot {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export class MCPServer {
  private tools = new Map<string, MCPToolHandler>();

  registerTool(handler: MCPToolHandler): void {
    this.tools.set(handler.name, handler);
  }

  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  listTools(): MCPServerSnapshot {
    return {
      tools: Array.from(this.tools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const handler = this.tools.get(name);
    if (!handler) {
      return { success: false, data: null, error: `Unknown MCP tool '${name}'` };
    }
    try {
      return await handler.execute(input);
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
