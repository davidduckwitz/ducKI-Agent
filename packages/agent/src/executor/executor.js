export class Executor {
    logger;
    tools = new Map();
    constructor(logger) {
        this.logger = logger;
    }
    registerTool(tool) {
        this.tools.set(tool.name, tool);
        this.logger.debug("Tool registered", { name: tool.name });
    }
    unregisterTool(name) {
        this.tools.delete(name);
    }
    hasTool(name) {
        return this.tools.has(name);
    }
    getToolDefinitions() {
        return Array.from(this.tools.values()).map((t) => t.definition);
    }
    async execute(toolName, input) {
        const tool = this.tools.get(toolName);
        if (!tool) {
            return {
                success: false,
                data: null,
                error: `Tool '${toolName}' not found. Available tools: ${Array.from(this.tools.keys()).join(", ")}`,
            };
        }
        const startTime = Date.now();
        this.logger.info("Executing tool", { toolName, input });
        try {
            const result = await tool.execute(input);
            const executionTime = Date.now() - startTime;
            this.logger.info("Tool executed", {
                toolName,
                success: result.success,
                executionTime,
            });
            return {
                ...result,
                metadata: { toolName, executionTime },
            };
        }
        catch (error) {
            const executionTime = Date.now() - startTime;
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error("Tool execution failed", { toolName, error: message });
            return {
                success: false,
                data: null,
                error: message,
                metadata: { toolName, executionTime },
            };
        }
    }
    listTools() {
        return Array.from(this.tools.values()).map((t) => ({
            name: t.name,
            description: t.description,
        }));
    }
}
//# sourceMappingURL=executor.js.map