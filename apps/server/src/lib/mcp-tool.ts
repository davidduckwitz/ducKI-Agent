import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { MCPRegistry } from "@ducki/mcp";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

export function createMcpTool(registry: MCPRegistry): ToolExecutor {
  return {
    name: "mcp",
    description: "Manage MCP servers, discover remote tools, and call MCP tools",
    definition: {
      name: "mcp",
      description: "MCP server management and remote tool execution",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list_servers", "list_tools", "call_tool"],
          },
          serverId: { type: "string", description: "Optional MCP server id" },
          toolName: { type: "string", description: "MCP tool name for call_tool" },
          input: { type: "object", description: "Tool input for call_tool" },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = String(input["action"] ?? "").toLowerCase();
      try {
        switch (action) {
          case "list_servers":
            return ok(registry.getServerStatus());
          case "list_tools":
            return ok(registry.listTools());
          case "call_tool": {
            const toolName = String(input["toolName"] ?? "").trim();
            if (!toolName) return fail("toolName is required for call_tool");
            const serverId = input["serverId"] ? String(input["serverId"]) : undefined;
            const payload = (input["input"] && typeof input["input"] === "object")
              ? (input["input"] as Record<string, unknown>)
              : {};
            return await registry.callTool(toolName, payload, serverId);
          }
          default:
            return fail(`Unknown mcp action: ${action}`);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
