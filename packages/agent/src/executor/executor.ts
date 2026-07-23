import type { ToolDefinition, ToolResult, ToolExecutor } from "@ducki/shared";
import type { Logger } from "@ducki/logger";

export interface ToolCallWithId {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
}

export class Executor {
  private tools = new Map<string, ToolExecutor>();

  constructor(private readonly logger: Logger) {}

  registerTool(tool: ToolExecutor): void {
    this.tools.set(tool.name, tool);
    this.logger.debug("Tool registered", { name: tool.name });
  }

  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
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
    } catch (error) {
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

  listTools(): { name: string; description: string }[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  /**
   * Execute multiple tool calls in parallel.
   * Returns array of results in the same order as input calls.
   */
  async executeBatch(calls: ToolCallWithId[]): Promise<Array<{ id: string; result: ToolResult }>> {
    const startTime = Date.now();
    const promises = calls.map(async (call) => ({
      id: call.id,
      result: await this.execute(call.toolName, call.input),
    }));

    const results = await Promise.allSettled(promises);
    const executionTime = Date.now() - startTime;

    this.logger.info("Batch tool execution completed", {
      total: calls.length,
      executionTime,
      results: results.map((r) => (r.status === "fulfilled" ? "success" : "error")),
    });

    return results.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      // Handle promise rejection
      const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
      return {
        id: calls[index]?.id || `error_${index}`,
        result: {
          success: false,
          data: null,
          error: `Batch execution failed: ${error}`,
          metadata: { toolName: calls[index]?.toolName || "unknown", executionTime: 0 },
        } as ToolResult,
      };
    });
  }
}
