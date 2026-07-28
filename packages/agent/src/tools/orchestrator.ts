/**
 * Tool Orchestrator
 *
 * Improved orchestration loop following article best practices:
 * - Extract tool calls from model responses
 * - Validate arguments against schemas
 * - Execute tools safely
 * - Format results for model comprehension
 */

/**
 * Generic executor interface for compatibility with existing systems
 */
export interface ToolExecutor {
  executeTool(name: string, input: unknown): Promise<unknown>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolName: string;
  success: boolean;
  result: string;
  executionTimeMs: number;
}

/**
 * Extract tool calls from model response
 * Supports multiple formats:
 * - Native JSON: {"function": {"name": "tool_name", "arguments": {...}}}
 * - [TOOL:name(...)] format (legacy)
 */
export function extractToolCalls(response: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];

  // Try native JSON format first (for Gemma4 native tool-calling)
  try {
    const jsonMatch = response.match(/\{[\s\S]*"function"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.function?.name && parsed.function?.arguments) {
        toolCalls.push({
          name: parsed.function.name,
          arguments: parsed.function.arguments,
        });
      }
    }
  } catch {
    // Not JSON format, try legacy format
  }

  // Fall back to [TOOL:...] format (legacy)
  if (toolCalls.length === 0) {
    const regex = /\[TOOL:(\w+)\(({[\s\S]*?})\)\]/g;
    let match;
    while ((match = regex.exec(response)) !== null) {
      const toolName = match[1]!;
      try {
        const args = JSON.parse(match[2]!);
        toolCalls.push({ name: toolName, arguments: args });
      } catch {
        console.warn(`Failed to parse arguments for ${toolName}:`, match[2]);
      }
    }
  }

  return toolCalls;
}

/**
 * Execute tool calls and collect results
 * Implements safety checks from Gemma4 best practices:
 * - Error handling with informative messages
 * - Execution timing for debugging
 * - Graceful failure handling
 */
export async function executeToolCalls(
  toolCalls: ToolCall[],
  executor: ToolExecutor
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  for (const call of toolCalls) {
    const startTime = Date.now();

    try {
      const result = await executor.executeTool(call.name, call.arguments);
      const executionTimeMs = Date.now() - startTime;

      results.push({
        toolName: call.name,
        success: true,
        result: typeof result === "string" ? result : JSON.stringify(result),
        executionTimeMs,
      });

      console.log(`[TOOL-EXEC] ${call.name}: OK (${executionTimeMs}ms)`);
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;

      results.push({
        toolName: call.name,
        success: false,
        result: error instanceof Error ? error.message : String(error),
        executionTimeMs,
      });

      console.warn(`[TOOL-EXEC] ${call.name}: FAILED - ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return results;
}

/**
 * Format tool results for model comprehension
 * Follows article best practice: return informative strings, not just data
 */
export function formatToolResults(results: ToolResult[]): string[] {
  return results.map((result) => {
    if (!result.success) {
      return `Error executing ${result.toolName}: ${result.result}`;
    }

    // Check for empty output (like the article's Python executor check)
    if (!result.result || result.result.trim() === "") {
      return `${result.toolName} executed successfully but produced no output. ` +
             `If you need to perform further analysis, provide more specific parameters.`;
    }

    return result.result;
  });
}

/**
 * Main orchestration cycle
 * Follows Gemma4 article's two-pass pattern:
 * 1. Model processes request + tools
 * 2. Extract and execute tool calls
 * 3. Return formatted results for model to process
 */
export async function orchestrateCycle(
  modelResponse: string,
  executor: ToolExecutor
): Promise<{
  hasToolCalls: boolean;
  toolResults: ToolResult[];
  formattedResults: string[];
}> {
  // Extract tool calls from response
  const toolCalls = extractToolCalls(modelResponse);

  if (toolCalls.length === 0) {
    return {
      hasToolCalls: false,
      toolResults: [],
      formattedResults: [],
    };
  }

  // Execute tool calls
  const toolResults = await executeToolCalls(toolCalls, executor);

  // Format results for model
  const formattedResults = formatToolResults(toolResults);

  return {
    hasToolCalls: true,
    toolResults,
    formattedResults,
  };
}
