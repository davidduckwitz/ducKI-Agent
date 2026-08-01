import type { Logger } from "@ducki/logger";
import type { ToolHealthMonitor } from "../tool-health/tool-health-monitor.js";

export type ErrorStrategyAction = "retry" | "fallback" | "fail" | "partial";

export type ErrorStrategyFn = (
  error: Error,
  toolName: string,
  input: Record<string, unknown>,
  attempt: number
) => ErrorStrategyAction;

/**
 * Tool-specific error handling strategies
 * Defines how to handle different error types for each tool
 */
export const TOOL_ERROR_STRATEGIES: Record<
  string,
  Record<string, ErrorStrategyFn>
> = {
  shell: {
    timeout: () => "fail", // Shell timeouts are usually real hangs
    validation: () => "fail", // Input error = code error
    execution: (e, t, i, a) => (a < 2 ? "retry" : "fail"),
    circuit_breaker: () => "fail",
    unknown: (e, t, i, a) => (a < 2 ? "retry" : "fail"),
  },

  file_system: {
    timeout: () => "fail", // File ops shouldn't timeout
    validation: () => "fail", // Invalid path/params = bug
    execution: () => "fail", // IO errors usually permanent
    circuit_breaker: () => "fail",
    unknown: () => "fail",
  },

  http: {
    timeout: (e, t, i, a) => (a < 2 ? "retry" : "fail"), // Network glitch
    validation: () => "fail", // Bad URL/params = bug
    execution: (e, t, i, a) => (a < 2 ? "retry" : "partial"), // Server errors = partial
    circuit_breaker: () => "fail",
    unknown: (e, t, i, a) => (a < 2 ? "retry" : "partial"),
  },

  browser: {
    timeout: () => "partial", // Browser timeout = partial results
    validation: () => "fail",
    execution: (e, t, i, a) => (a < 1 ? "retry" : "partial"),
    circuit_breaker: () => "fail",
    unknown: (e, t, i, a) => (a < 1 ? "retry" : "partial"),
  },

  project: {
    timeout: () => "fail",
    validation: () => "fail",
    execution: (e, t, i, a) => (a < 2 ? "retry" : "fail"),
    circuit_breaker: () => "fail",
    unknown: (e, t, i, a) => (a < 2 ? "retry" : "fail"),
  },

  task: {
    timeout: () => "fail",
    validation: () => "fail",
    execution: (e, t, i, a) => (a < 2 ? "retry" : "fail"),
    circuit_breaker: () => "fail",
    unknown: (e, t, i, a) => (a < 2 ? "retry" : "fail"),
  },

  memory: {
    timeout: (e, t, i, a) => (a < 1 ? "retry" : "partial"), // Memory ops partial OK
    validation: () => "fail",
    execution: (e, t, i, a) => (a < 1 ? "retry" : "partial"),
    circuit_breaker: () => "partial",
    unknown: (e, t, i, a) => (a < 1 ? "retry" : "partial"),
  },

  workflow: {
    timeout: () => "fail",
    validation: () => "fail",
    execution: (e, t, i, a) => (a < 1 ? "retry" : "fail"),
    circuit_breaker: () => "fail",
    unknown: (e, t, i, a) => (a < 1 ? "retry" : "fail"),
  },
};

/**
 * Get default error strategy for unknown tool
 */
function getDefaultStrategy(errorType: string): ErrorStrategyAction {
  if (errorType === "timeout") return "retry";
  if (errorType === "validation") return "fail";
  return "retry";
}

/**
 * Get error handling strategy for a tool and error type
 */
export function getErrorStrategy(
  toolName: string,
  errorType: string
): ErrorStrategyFn {
  const strategies = TOOL_ERROR_STRATEGIES[toolName];

  if (!strategies) {
    // Default strategy for unknown tools
    return () => getDefaultStrategy(errorType);
  }

  const strategy = strategies[errorType];
  if (!strategy) {
    return () => getDefaultStrategy(errorType);
  }

  return strategy;
}

/**
 * Execute tool with error strategy handling
 */
export async function executeWithErrorStrategy(
  toolName: string,
  input: Record<string, unknown>,
  executor: { execute: (name: string, input: Record<string, unknown>) => Promise<any> },
  healthMonitor: ToolHealthMonitor,
  logger: Logger
): Promise<any> {
  const startTime = Date.now();
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < 3) {
    try {
      attempt++;
      const result = await executor.execute(toolName, input);

      const executionTime = Date.now() - startTime;
      healthMonitor.recordExecution(toolName, result.success, executionTime);

      if (result.success) {
        return result;
      }

      // Tool executed but returned success=false
      lastError = new Error(result.error || "Tool returned success=false");
      continue; // Try next attempt
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const executionTime = Date.now() - startTime;
      healthMonitor.recordExecution(toolName, false, executionTime, lastError);

      // Determine if we should retry
      const errorType = classifyError(lastError);
      const strategy = getErrorStrategy(toolName, errorType);
      const action = strategy(lastError, toolName, input, attempt);

      if (action === "retry" && attempt < 3) {
        const backoffMs = Math.pow(2, attempt - 1) * 500;
        logger.debug("Retrying tool execution after error", {
          toolName,
          attempt,
          backoffMs,
          errorType,
        });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      // Action is fail or partial - return error result
      return {
        success: false,
        error: lastError.message,
        data: action === "partial" ? { partial: true } : null,
      };
    }
  }

  // Max attempts exhausted
  return {
    success: false,
    error: lastError?.message || "Tool execution failed after max attempts",
    data: null,
  };
}

/**
 * Classify error type from error message
 */
function classifyError(error: Error): string {
  const msg = error.message.toLowerCase();

  if (msg.includes("validation") || msg.includes("invalid")) {
    return "validation";
  }
  if (msg.includes("timeout")) {
    return "timeout";
  }
  if (msg.includes("circuit")) {
    return "circuit_breaker";
  }

  return "execution";
}
