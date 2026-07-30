/**
 * Hook registry and execution engine for agent lifecycle events.
 * Enables custom logic at key decision points without modifying core Agent code.
 */

import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import type { AgentHookName } from "./hook-names.js";

export interface AgentHook<TContext = unknown> {
  /** Unique hook identifier */
  name: string;
  /** Execution priority: 0-100, higher runs later. Default: 50 */
  priority?: number;
  /** Async handler function */
  handler: (context: TContext) => Promise<AgentHookResult>;
}

export interface AgentHookResult {
  /** Whether to proceed with the operation. If false, abort with reason. */
  proceed: boolean;
  /** Reason for abort (if proceed=false) */
  reason?: string;
  /** Modified context or output. Merged back into execution context. */
  output?: Record<string, unknown>;
}

export class HookRegistry {
  private hooks = new Map<string, AgentHook[]>();
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? getRootLogger().child("HookRegistry");
  }

  /**
   * Register a hook for a lifecycle event.
   * Multiple hooks can be registered for the same event; they execute in priority order.
   */
  register(hookName: string, hook: AgentHook<any>): void {
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, []);
    }
    const hookList = this.hooks.get(hookName)!;
    hookList.push(hook as AgentHook);
    // Sort by priority (higher runs later)
    hookList.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    this.logger.debug("Hook registered", { hookName, hook: hook.name, priority: hook.priority ?? 50 });
  }

  /**
   * Unregister a hook by name.
   */
  unregister(hookName: string, hookId: string): boolean {
    const hookList = this.hooks.get(hookName);
    if (!hookList) return false;
    const index = hookList.findIndex((h) => h.name === hookId);
    if (index === -1) return false;
    hookList.splice(index, 1);
    this.logger.debug("Hook unregistered", { hookName, hookId });
    return true;
  }

  /**
   * Execute all hooks for an event sequentially.
   * Hooks execute in priority order. If any hook returns proceed=false, execution stops.
   */
  async executeHooks(hookName: string, context: unknown): Promise<AgentHookResult> {
    const hookList = this.hooks.get(hookName) ?? [];
    if (hookList.length === 0) {
      return { proceed: true };
    }

    let mergedOutput: Record<string, unknown> = {};

    for (const hook of hookList) {
      try {
        this.logger.debug("Executing hook", { hookName, hook: hook.name });
        const result = await hook.handler(context);

        if (!result.proceed) {
          this.logger.warn("Hook aborted execution", { hookName, hook: hook.name, reason: result.reason });
          return result;
        }

        if (result.output) {
          mergedOutput = { ...mergedOutput, ...result.output };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("Hook execution failed", { hookName, hook: hook.name, error: message });
        return {
          proceed: false,
          reason: `Hook ${hook.name} failed: ${message}`,
        };
      }
    }

    return { proceed: true, output: Object.keys(mergedOutput).length > 0 ? mergedOutput : undefined };
  }

  /**
   * Get all registered hooks for an event (for debugging/inspection).
   */
  getHooks(hookName: string): AgentHook[] {
    return this.hooks.get(hookName) ?? [];
  }

  /**
   * Clear all hooks (useful for testing).
   */
  clearAll(): void {
    this.hooks.clear();
    this.logger.debug("All hooks cleared");
  }
}
