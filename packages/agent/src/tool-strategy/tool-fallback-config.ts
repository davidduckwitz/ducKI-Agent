/**
 * Tool Fallback Configuration
 * Defines alternative tool chains for when primary tools fail
 */

export type ExecutionStrategy = "sequential" | "parallel";

export interface ToolFallbackChain {
  primary: string;
  fallbacks: string[];
  strategy: ExecutionStrategy;
  description: string;
}

/**
 * Central fallback mapping for tools.
 * When a primary tool fails, the system attempts fallback tools in order.
 */
export const TOOL_FALLBACK_CHAINS: Record<string, ToolFallbackChain> = {
  shell: {
    primary: "shell",
    fallbacks: [],
    strategy: "sequential",
    description: "Execute shell commands (no direct fallback available)",
  },

  file_system: {
    primary: "file_system",
    fallbacks: [],
    strategy: "sequential",
    description: "File operations via file_system tool",
  },

  http: {
    primary: "http",
    fallbacks: [],
    strategy: "sequential",
    description: "HTTP requests via native http tool",
  },

  browser: {
    primary: "browser",
    fallbacks: [],
    strategy: "sequential",
    description: "Browser automation via primary browser tool",
  },

  project: {
    primary: "project",
    fallbacks: ["task"],
    strategy: "sequential",
    description: "Project management with fallback to task tool",
  },

  task: {
    primary: "task",
    fallbacks: ["project"],
    strategy: "sequential",
    description: "Task management with fallback to project tool",
  },

  memory: {
    primary: "memory",
    fallbacks: [],
    strategy: "sequential",
    description: "Memory/knowledge operations (no fallback)",
  },

  workflow: {
    primary: "workflow",
    fallbacks: [],
    strategy: "sequential",
    description: "Workflow management (no fallback)",
  },
};

/**
 * Get fallback chain for a tool, or return empty chain if not defined
 */
export function getFallbackChain(toolName: string): ToolFallbackChain {
  return (
    TOOL_FALLBACK_CHAINS[toolName] ?? {
      primary: toolName,
      fallbacks: [],
      strategy: "sequential",
      description: `No fallback defined for ${toolName}`,
    }
  );
}

/**
 * Check if a tool has fallback options
 */
export function hasFailoverOptions(toolName: string): boolean {
  const chain = TOOL_FALLBACK_CHAINS[toolName];
  return chain ? chain.fallbacks.length > 0 : false;
}

/**
 * Get all tools to try for a given primary tool (primary + fallbacks)
 */
export function getToolsToTry(toolName: string): string[] {
  const chain = getFallbackChain(toolName);
  return [chain.primary, ...chain.fallbacks];
}
