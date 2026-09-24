import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { MCPRegistry } from "@ducki/mcp";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

export function createMcpTool(registry: MCPRegistry): ToolExecutor {
  const usage = 'MCP is a router, not the remote tool itself. Discover with {"action":"list_tools","serverId":"godot-mcp"}. '
    + 'Call with {"action":"call_tool","serverId":"godot-mcp","toolName":"session_manage","input":{"op":"list"}}. '
    + 'Through tool_call use {"tool_name":"mcp","arguments":{"action":"call_tool","serverId":"godot-mcp","toolName":"session_manage","input":{"op":"list"}}}. '
    + 'Use discovered server IDs and tool names. Remote arguments such as op belong inside input. For Godot workflows load skill godot-mcp.';
  const invalid = (message: string): ToolResult => fail(`${message} No remote tool was called. ${usage}`);
  return {
    name: "mcp",
    description: "Control applications such as Godot through configured MCP servers. Discover tools with list_tools, then call_tool with serverId, toolName and input matching inputSchema.",
    definition: {
      name: "mcp",
      description: `Control external applications through MCP. ${usage}`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list_servers", "list_tools", "call_tool"],
          },
          serverId: { type: "string", description: "Optional MCP server id" },
          toolName: { type: "string", description: "Required remote tool name for call_tool; optional exact-name filter for list_tools" },
          input: { type: "object", additionalProperties: true, description: 'Remote arguments for call_tool, e.g. {"op":"list"} for session_manage. Never put op at the top level.' },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = String(input["action"] ?? "").trim().toLowerCase();
      try {
        switch (action) {
          case "list_servers":
            return ok(registry.getServerStatus().map(({ env: _env, ...status }) => status));
          case "list_tools":
            return ok(registry.listTools().filter(tool =>
              (!input["serverId"] || tool.serverId === input["serverId"]) &&
              (!input["toolName"] || tool.name === input["toolName"])));
          case "call_tool": {
            const toolName = String(input["toolName"] ?? "").trim();
            if (!toolName) return invalid("toolName is required for call_tool.");
            const serverId = input["serverId"] ? String(input["serverId"]) : undefined;
            const misplaced = Object.keys(input).filter(key => !["action", "serverId", "toolName", "input"].includes(key));
            if (misplaced.length) return invalid(`Unexpected top-level fields: ${misplaced.join(", ")}. Put remote arguments inside input.`);
            if (input["input"] !== undefined && (!input["input"] || typeof input["input"] !== "object" || Array.isArray(input["input"]))) {
              return invalid("input must be a JSON object, not a string, array or null.");
            }
            const payload = (input["input"] ?? {}) as Record<string, unknown>;
            return await registry.callTool(toolName, payload, serverId);
          }
          default:
            return invalid(action ? `Unknown mcp action: ${action}.` : "Missing MCP action. The server connection has not been tested by this invalid request.");
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
