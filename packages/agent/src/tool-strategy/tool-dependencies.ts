import type { Logger } from "@ducki/logger";

export interface ToolDependency {
  toolName: string;
  requiredTools: string[];
  requiredServices: string[];
  requiredEnvVars: string[];
}

/**
 * Tool dependency definitions
 * Specifies what other tools/services a tool depends on
 */
export const TOOL_DEPENDENCIES: Record<string, ToolDependency> = {
  browser: {
    toolName: "browser",
    requiredTools: ["screenshot"],
    requiredServices: ["browser-engine"],
    requiredEnvVars: [],
  },

  screenshot: {
    toolName: "screenshot",
    requiredTools: ["browser"],
    requiredServices: [],
    requiredEnvVars: [],
  },

  coding_agent: {
    toolName: "coding_agent",
    requiredTools: ["shell", "file_system"],
    requiredServices: [],
    requiredEnvVars: [],
  },

  shell: {
    toolName: "shell",
    requiredTools: [],
    requiredServices: [],
    requiredEnvVars: [],
  },

  file_system: {
    toolName: "file_system",
    requiredTools: [],
    requiredServices: [],
    requiredEnvVars: [],
  },

  http: {
    toolName: "http",
    requiredTools: [],
    requiredServices: [],
    requiredEnvVars: [],
  },

  project: {
    toolName: "project",
    requiredTools: [],
    requiredServices: ["database"],
    requiredEnvVars: [],
  },

  task: {
    toolName: "task",
    requiredTools: [],
    requiredServices: ["database"],
    requiredEnvVars: [],
  },

  memory: {
    toolName: "memory",
    requiredTools: [],
    requiredServices: ["database"],
    requiredEnvVars: [],
  },

  workflow: {
    toolName: "workflow",
    requiredTools: [],
    requiredServices: ["database"],
    requiredEnvVars: [],
  },
};

/**
 * Tool dependency checker
 */
export class ToolDependencyChecker {
  constructor(
    private logger: Logger,
    private availableTools: Set<string>,
    private healthyServices: Set<string>
  ) {}

  /**
   * Check if a tool can be executed (all dependencies met)
   */
  canExecute(toolName: string): { canExecute: boolean; missingDeps: string[] } {
    const deps = TOOL_DEPENDENCIES[toolName];

    if (!deps) {
      return { canExecute: true, missingDeps: [] }; // Unknown tool = no known deps
    }

    const missing: string[] = [];

    // Check required tools
    for (const req of deps.requiredTools) {
      if (!this.availableTools.has(req)) {
        missing.push(`tool: ${req}`);
      }
    }

    // Check required services
    for (const req of deps.requiredServices) {
      if (!this.healthyServices.has(req)) {
        missing.push(`service: ${req}`);
      }
    }

    // Check required env vars
    for (const req of deps.requiredEnvVars) {
      if (!process.env[req]) {
        missing.push(`env: ${req}`);
      }
    }

    return {
      canExecute: missing.length === 0,
      missingDeps: missing,
    };
  }

  /**
   * Get dependencies for a tool
   */
  getDependencies(toolName: string): ToolDependency | null {
    return TOOL_DEPENDENCIES[toolName] ?? null;
  }

  /**
   * Update available tools
   */
  setAvailableTools(tools: Set<string>): void {
    this.availableTools = tools;
  }

  /**
   * Update healthy services
   */
  setHealthyServices(services: Set<string>): void {
    this.healthyServices = services;
  }
}
