export class MCPServer {
    tools = new Map();
    registerTool(handler) {
        this.tools.set(handler.name, handler);
    }
    unregisterTool(name) {
        this.tools.delete(name);
    }
    listTools() {
        return {
            tools: Array.from(this.tools.values()).map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
            })),
        };
    }
    async callTool(name, input) {
        const handler = this.tools.get(name);
        if (!handler) {
            return { success: false, data: null, error: `Unknown MCP tool '${name}'` };
        }
        try {
            return await handler.execute(input);
        }
        catch (error) {
            return {
                success: false,
                data: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
}
//# sourceMappingURL=server.js.map