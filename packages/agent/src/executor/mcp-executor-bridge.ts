import type { ToolExecutor, ToolResult, ToolDefinition } from "@ducki/shared";

/**
 * MCP Tool Handler interface (local definition if @ducki/mcp not available)
 */
export interface MCPToolHandler {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * Converts Agent Executor Tools into MCP Tool Handlers
 * This allows the agent to expose its tools as MCP functions for better LLM integration
 */
export class MCPExecutorBridge {
  /**
   * Convert a single ToolExecutor to an MCP ToolHandler
   */
  static toMCPToolHandler(executor: ToolExecutor): MCPToolHandler {
    return {
      name: executor.name,
      description: executor.description,
      inputSchema: executor.definition.parameters || {},
      execute: async (input: Record<string, unknown>) => {
        return await executor.execute(input);
      },
    };
  }

  /**
   * Convert multiple ToolExecutors to MCP ToolHandlers
   */
  static toMCPToolHandlers(executors: ToolExecutor[]): MCPToolHandler[] {
    return executors.map((executor) => this.toMCPToolHandler(executor));
  }

  /**
   * Generate MCP-compatible tool descriptions with examples
   */
  static enrichToolDescription(
    name: string,
    originalDescription: string,
    inputSchema: Record<string, unknown>
  ): string {
    const schemaProps = (inputSchema as any)?.properties || {};
    const requiredFields = (inputSchema as any)?.required || [];

    const fieldDocs = Object.entries(schemaProps)
      .map(([key, prop]: [string, any]) => {
        const required = requiredFields.includes(key) ? " (required)" : " (optional)";
        const type = prop.type || "unknown";
        const desc = prop.description || "";
        return `  - ${key}: ${type}${required} - ${desc}`;
      })
      .join("\n");

    const examples = this.generateExamples(name, schemaProps, requiredFields);

    return `${originalDescription}

Parameters:
${fieldDocs}

Usage:
${examples}`;
  }

  /**
   * Generate usage examples based on input schema
   */
  private static generateExamples(
    toolName: string,
    properties: Record<string, any>,
    required: string[]
  ): string {
    const examples: string[] = [];

    // Example 1: Minimal required fields
    if (required.length > 0) {
      const minimalParams: Record<string, unknown> = {};
      for (const field of required) {
        const prop = properties[field];
        if (prop.type === "string") minimalParams[field] = "value";
        else if (prop.type === "number") minimalParams[field] = 0;
        else if (prop.type === "boolean") minimalParams[field] = true;
        else minimalParams[field] = null;
      }
      examples.push(`[TOOL:${toolName}(${JSON.stringify(minimalParams)})]\n`);
    }

    // Example 2: With common optional fields
    const commonOptional = Object.entries(properties)
      .slice(0, 2)
      .reduce(
        (acc, [key, prop]: [string, any]) => {
          if (prop.type === "string") acc[key] = "example";
          else if (prop.type === "number") acc[key] = 1;
          else if (prop.type === "boolean") acc[key] = false;
          return acc;
        },
        {} as Record<string, unknown>
      );

    if (Object.keys(commonOptional).length > 0) {
      examples.push(`[TOOL:${toolName}(${JSON.stringify(commonOptional)})]\n`);
    }

    return examples.length > 0 ? examples.join("") : `[TOOL:${toolName}({})]\n`;
  }
}
