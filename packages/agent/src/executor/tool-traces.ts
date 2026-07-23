import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";

export interface ToolExecutionTrace {
  toolName: string;
  inputSize: number;
  resultSize: number;
  durationMs: number;
  success: boolean;
  error?: string;
  parallelized: boolean;
  timestamp: string;
  executionIndex?: number;
}

/**
 * Collects and analyzes tool execution traces for performance monitoring and optimization.
 */
export class ToolTraceCollector {
  private logger: Logger;
  private traces: ToolExecutionTrace[] = [];
  private readonly maxTraces = 10000; // Keep last 10k traces

  constructor() {
    this.logger = getRootLogger().child("ToolTraceCollector");
  }

  /**
   * Record a tool execution trace.
   */
  recordTrace(trace: ToolExecutionTrace): void {
    this.traces.push(trace);

    // Keep circular buffer size
    if (this.traces.length > this.maxTraces) {
      this.traces = this.traces.slice(-this.maxTraces);
    }

    // Log warnings for slow or failed tools
    if (!trace.success) {
      this.logger.warn("Tool execution failed", {
        toolName: trace.toolName,
        error: trace.error,
        duration: trace.durationMs,
      });
    } else if (trace.durationMs > 30000) {
      this.logger.warn("Slow tool execution detected", {
        toolName: trace.toolName,
        duration: trace.durationMs,
      });
    }
  }

  /**
   * Get statistics for a specific tool.
   */
  getToolStats(toolName: string): {
    totalExecutions: number;
    successRate: number;
    avgDurationMs: number;
    p95DurationMs: number;
    p99DurationMs: number;
  } | null {
    const toolTraces = this.traces.filter((t) => t.toolName === toolName);
    if (toolTraces.length === 0) return null;

    const successful = toolTraces.filter((t) => t.success).length;
    const durations = toolTraces.map((t) => t.durationMs).sort((a, b) => a - b);

    return {
      totalExecutions: toolTraces.length,
      successRate: successful / toolTraces.length,
      avgDurationMs: durations.reduce((a, b) => a + b, 0) / durations.length,
      p95DurationMs: durations[Math.floor(durations.length * 0.95)] || 0,
      p99DurationMs: durations[Math.floor(durations.length * 0.99)] || 0,
    };
  }

  /**
   * Get slowest tools.
   */
  getSlowestTools(limit: number = 10): Array<{ toolName: string; avgDurationMs: number }> {
    const toolStats = new Map<string, { total: number; count: number }>();

    for (const trace of this.traces) {
      if (!toolStats.has(trace.toolName)) {
        toolStats.set(trace.toolName, { total: 0, count: 0 });
      }
      const stats = toolStats.get(trace.toolName)!;
      stats.total += trace.durationMs;
      stats.count++;
    }

    return Array.from(toolStats.entries())
      .map(([toolName, stats]) => ({
        toolName,
        avgDurationMs: stats.total / stats.count,
      }))
      .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
      .slice(0, limit);
  }

  /**
   * Get failure statistics.
   */
  getFailureStats(): {
    totalTraces: number;
    failureRate: number;
    failuresByTool: Record<string, number>;
  } {
    const failures = this.traces.filter((t) => !t.success);
    const failuresByTool: Record<string, number> = {};

    for (const trace of failures) {
      failuresByTool[trace.toolName] = (failuresByTool[trace.toolName] || 0) + 1;
    }

    return {
      totalTraces: this.traces.length,
      failureRate: failures.length / this.traces.length,
      failuresByTool,
    };
  }

  /**
   * Get parallelization statistics.
   */
  getParallelizationStats(): {
    parallelExecutions: number;
    sequentialExecutions: number;
    parallelizationRate: number;
  } {
    const parallel = this.traces.filter((t) => t.parallelized).length;
    const sequential = this.traces.length - parallel;

    return {
      parallelExecutions: parallel,
      sequentialExecutions: sequential,
      parallelizationRate: this.traces.length > 0 ? parallel / this.traces.length : 0,
    };
  }

  /**
   * Get all traces for a time range (last N hours).
   */
  getRecentTraces(hoursAgo: number = 24): ToolExecutionTrace[] {
    const cutoffTime = Date.now() - hoursAgo * 60 * 60 * 1000;
    return this.traces.filter((t) => new Date(t.timestamp).getTime() > cutoffTime);
  }

  /**
   * Export traces for external analysis.
   */
  exportTraces(): string {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        totalTraces: this.traces.length,
        traces: this.traces,
        summary: {
          slowestTools: this.getSlowestTools(5),
          failureStats: this.getFailureStats(),
          parallelizationStats: this.getParallelizationStats(),
        },
      },
      null,
      2
    );
  }

  /**
   * Clear all traces.
   */
  clear(): void {
    this.traces = [];
  }

  /**
   * Get trace count.
   */
  getTraceCount(): number {
    return this.traces.length;
  }
}

// Singleton instance
export const toolTraceCollector = new ToolTraceCollector();
