import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";

export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
  id?: string;
}

export interface ToolDependency {
  toolName: string;
  dependsOn: string[];
  canParallelize: (call1: ToolCall, call2: ToolCall) => boolean;
}

const DEFAULT_TOOL_DEPENDENCIES: Record<string, ToolDependency> = {
  filesystem: {
    toolName: "filesystem",
    dependsOn: [],
    canParallelize: (call1, call2) => {
      // Different file operations can run in parallel if on different paths
      const path1 = String(call1.input.path ?? "");
      const path2 = String(call2.input.path ?? "");
      if (!path1 || !path2) return false;
      return path1 !== path2 && !path1.startsWith(path2) && !path2.startsWith(path1);
    },
  },
  http: {
    toolName: "http",
    dependsOn: [],
    canParallelize: (call1, call2) => {
      // Different HTTP calls can run in parallel if to different URLs
      const url1 = String(call1.input.url ?? "");
      const url2 = String(call2.input.url ?? "");
      if (!url1 || !url2) return false;
      return url1 !== url2;
    },
  },
  shell: {
    toolName: "shell",
    dependsOn: [],
    canParallelize: () => false, // Shell commands typically not safe to parallelize
  },
  git: {
    toolName: "git",
    dependsOn: ["filesystem"],
    canParallelize: (call1, call2) => {
      // Different git repos can run in parallel
      const repo1 = String(call1.input.repo ?? "");
      const repo2 = String(call2.input.repo ?? "");
      return !!(repo1 && repo2 && repo1 !== repo2);
    },
  },
  browser: {
    toolName: "browser",
    dependsOn: [],
    canParallelize: (call1, call2) => {
      // Different browser contexts can run in parallel
      const context1 = String(call1.input.context ?? "default");
      const context2 = String(call2.input.context ?? "default");
      return context1 !== context2;
    },
  },
};

/**
 * Analyzes tool call dependencies and determines safe parallelization strategy.
 */
export class ToolExecutionGraph {
  private logger: Logger;
  private dependencies: Map<string, ToolDependency>;

  constructor(customDependencies?: Record<string, ToolDependency>) {
    this.logger = getRootLogger().child("ToolExecutionGraph");
    this.dependencies = new Map(
      Object.entries({ ...DEFAULT_TOOL_DEPENDENCIES, ...customDependencies })
    );
  }

  /**
   * Build execution plan - groups tool calls into batches that can run in parallel.
   * Returns array of arrays, where each inner array can execute in parallel.
   */
  buildExecutionPlan(calls: ToolCall[]): ToolCall[][] {
    if (calls.length <= 1) {
      return calls.map((c) => [c]);
    }

    const batches: ToolCall[][] = [];
    const processed = new Set<string>();
    const getCallId = (c: ToolCall) => c.id || `${c.toolName}_${JSON.stringify(c.input)}`;

    for (const call of calls) {
      const callId = getCallId(call);
      if (processed.has(callId)) continue;

      const batch: ToolCall[] = [call];
      processed.add(callId);

      // Try to add other calls to this batch if they're compatible
      for (const otherCall of calls) {
        const otherId = getCallId(otherCall);
        if (processed.has(otherId)) continue;
        if (!this.canParallelize(call, otherCall)) continue;

        batch.push(otherCall);
        processed.add(otherId);
      }

      batches.push(batch);
    }

    return batches;
  }

  /**
   * Check if two tool calls can run in parallel.
   */
  private canParallelize(call1: ToolCall, call2: ToolCall): boolean {
    const dep1 = this.dependencies.get(call1.toolName);
    const dep2 = this.dependencies.get(call2.toolName);

    if (!dep1 || !dep2) {
      // Unknown tools - be conservative and don't parallelize
      return false;
    }

    // Check if call2 depends on call1's tool
    if (dep2.dependsOn.includes(call1.toolName)) {
      return false;
    }

    // Check if call1 depends on call2's tool
    if (dep1.dependsOn.includes(call2.toolName)) {
      return false;
    }

    // Both tools are independent - check tool-specific parallelization rules
    return dep1.canParallelize(call1, call2) && dep2.canParallelize(call1, call2);
  }

  /**
   * Register custom tool dependency rules.
   */
  registerToolDependency(dependency: ToolDependency): void {
    this.dependencies.set(dependency.toolName, dependency);
    this.logger.debug("Tool dependency registered", { toolName: dependency.toolName });
  }

  /**
   * Get dependency info for a tool.
   */
  getDependency(toolName: string): ToolDependency | undefined {
    return this.dependencies.get(toolName);
  }
}
