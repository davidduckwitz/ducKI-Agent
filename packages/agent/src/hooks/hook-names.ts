/**
 * Standard hook names and their context shapes.
 * Hooks are execution points where custom logic can intercept or modify agent behavior.
 */

export const AGENT_HOOK_NAMES = {
  /** Before LLM model call. Can modify system prompt, messages, or context. */
  BEFORE_MODEL: "beforeModel",

  /** After LLM response received, before tool parsing. Can filter response or force completion. */
  AFTER_MODEL: "afterModel",

  /** Before tool execution. Can deny, transform input, or substitute tool. */
  BEFORE_TOOL: "beforeTool",

  /** After tool execution completes. Can transform result or synthesize outputs. */
  AFTER_TOOL: "afterTool",

  /** When tool result becomes a message. Can modify message or trigger side effects. */
  ON_TOOL_RESULT: "onToolResult",

  /** When run loop is about to exit. Can validate completion or force another iteration. */
  ON_COMPLETED: "onCompleted",
} as const;

export type AgentHookName = typeof AGENT_HOOK_NAMES[keyof typeof AGENT_HOOK_NAMES];

/**
 * Context shapes for each hook. Use these to understand what data is passed to your handler.
 */
export interface AgentHookContexts {
  [AGENT_HOOK_NAMES.BEFORE_MODEL]: {
    messages: Array<{ role: string; content: unknown }>;
    systemPrompt: string;
    tools: Array<{ name: string; description: string }>;
    context: {
      conversationId?: number;
      iteration: number;
      maxIterations: number;
      toolsUsedInRun: string[];
    };
  };

  [AGENT_HOOK_NAMES.AFTER_MODEL]: {
    response: string;
    conversationMessages: Array<{ role: string; content: unknown }>;
    iteration: number;
  };

  [AGENT_HOOK_NAMES.BEFORE_TOOL]: {
    toolName: string;
    input: Record<string, unknown>;
    preflight: {
      validated: boolean;
      issues?: string[];
    };
  };

  [AGENT_HOOK_NAMES.AFTER_TOOL]: {
    toolName: string;
    input: Record<string, unknown>;
    result: {
      success: boolean;
      data?: unknown;
      error?: string;
    };
    executionMetadata: {
      durationMs: number;
      timestamp: string;
    };
  };

  [AGENT_HOOK_NAMES.ON_TOOL_RESULT]: {
    toolName: string;
    result: {
      success: boolean;
      data?: unknown;
      error?: string;
    };
    formattedMessage: {
      role: string;
      content: unknown;
    };
  };

  [AGENT_HOOK_NAMES.ON_COMPLETED]: {
    reason: "success" | "max_iterations" | "error" | "no_tool_calls" | "forced";
    response: string;
    iterations: number;
    toolsUsed: string[];
  };
}
