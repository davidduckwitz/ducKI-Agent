import type { Logger } from "@ducki/logger";
// Optional Database type support removed - use in-memory storage only

export interface ToolHealthMetrics {
  toolName: string;
  totalExecutions: number;
  successCount: number;
  failureCount: number;
  lastSuccess: number;
  lastFailure: number;
  averageExecutionTimeMs: number;
  errorTypes: Map<string, number>;
  healthScore: number; // 0-100
}

export type ErrorType =
  | "validation"
  | "timeout"
  | "execution"
  | "circuit_breaker"
  | "unknown";

function classifyErrorType(errorMsg: string): ErrorType {
  if (
    errorMsg.includes("validation") ||
    errorMsg.includes("Invalid") ||
    errorMsg.includes("required")
  ) {
    return "validation";
  }
  if (errorMsg.includes("timeout") || errorMsg.includes("Timeout")) {
    return "timeout";
  }
  if (errorMsg.includes("circuit")) {
    return "circuit_breaker";
  }
  return "execution";
}

/**
 * Monitors tool health with success rates, execution times, and error tracking
 */
export class ToolHealthMonitor {
  private metrics: Map<string, ToolHealthMetrics> = new Map();
  private readonly logger: Logger;
  private readonly PERSISTENCE_INTERVAL = 30000; // Persist metrics every 30s
  private persistenceTimer: NodeJS.Timeout | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
    this.startPersistenceTimer();
  }

  /**
   * Record a tool execution result
   */
  recordExecution(
    toolName: string,
    success: boolean,
    executionTimeMs: number,
    error?: Error | string
  ): void {
    const metrics = this.getOrCreate(toolName);

    metrics.totalExecutions++;
    if (success) {
      metrics.successCount++;
      metrics.lastSuccess = Date.now();
    } else {
      metrics.failureCount++;
      metrics.lastFailure = Date.now();

      if (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const errorType = classifyErrorType(errorMsg);
        metrics.errorTypes.set(errorType, (metrics.errorTypes.get(errorType) ?? 0) + 1);
      }
    }

    // Update average execution time
    metrics.averageExecutionTimeMs =
      (metrics.averageExecutionTimeMs * (metrics.totalExecutions - 1) + executionTimeMs) /
      metrics.totalExecutions;

    // Recalculate health score
    metrics.healthScore = this.calculateHealthScore(metrics);

    this.logger.debug("Tool execution recorded", {
      toolName,
      success,
      healthScore: metrics.healthScore,
      totalExecutions: metrics.totalExecutions,
    });
  }

  /**
   * Calculate health score (0-100) based on success rate and recency
   */
  private calculateHealthScore(metrics: ToolHealthMetrics): number {
    if (metrics.totalExecutions === 0) return 50; // Neutral for new tools

    const successRate = metrics.successCount / metrics.totalExecutions;

    // Recency factor: recent failures → lower score
    const timeSinceFailure = Date.now() - metrics.lastFailure;
    const recencyDecay = Math.min(timeSinceFailure / (1000 * 60 * 60), 1); // 1 hour decay

    // Base score from success rate
    let score = successRate * 80; // Max 80 from success

    // Recency bonus: longer without failure → higher score
    score += recencyDecay * 20; // Max +20 from recency

    return Math.round(score);
  }

  /**
   * Get health metrics for a specific tool
   */
  getHealth(toolName: string): ToolHealthMetrics | null {
    return this.metrics.get(toolName) ?? null;
  }

  /**
   * Get all health metrics, sorted by health score (best first)
   */
  getAllHealthMetrics(): ToolHealthMetrics[] {
    return Array.from(this.metrics.values()).sort(
      (a, b) => b.healthScore - a.healthScore
    );
  }

  /**
   * Check if tool is healthy (above threshold)
   */
  isToolHealthy(toolName: string, minScore: number = 70): boolean {
    const metrics = this.getHealth(toolName);
    return metrics ? metrics.healthScore >= minScore : true; // Unknown = assume OK
  }

  /**
   * Get tools below health threshold
   */
  getUnhealthyTools(maxScore: number = 50): ToolHealthMetrics[] {
    return this.getAllHealthMetrics().filter((m) => m.healthScore <= maxScore);
  }

  /**
   * Get health summary for monitoring
   */
  getHealthSummary(): {
    totalTools: number;
    healthyTools: number;
    unhealthyTools: number;
    averageHealthScore: number;
    toolsWithErrors: string[];
  } {
    const all = this.getAllHealthMetrics();
    const unhealthy = all.filter((m) => m.healthScore < 70);
    const avgScore = all.length > 0 ? Math.round(all.reduce((sum, m) => sum + m.healthScore, 0) / all.length) : 0;

    return {
      totalTools: all.length,
      healthyTools: all.length - unhealthy.length,
      unhealthyTools: unhealthy.length,
      averageHealthScore: avgScore,
      toolsWithErrors: unhealthy.map((m) => m.toolName),
    };
  }

  /**
   * Get error summary for a tool
   */
  getToolErrorSummary(toolName: string): {
    errorType: string;
    count: number;
  }[] {
    const metrics = this.getHealth(toolName);
    if (!metrics) return [];

    return Array.from(metrics.errorTypes.entries())
      .map(([errorType, count]) => ({ errorType, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Reset metrics for a tool
   */
  reset(toolName: string): void {
    this.metrics.delete(toolName);
    this.logger.info("Tool health metrics reset", { toolName });
  }

  /**
   * Reset all metrics
   */
  resetAll(): void {
    this.metrics.clear();
    this.logger.info("All tool health metrics reset");
  }

  /**
   * Start persistence timer
   */
  private startPersistenceTimer(): void {
    if (this.persistenceTimer) clearInterval(this.persistenceTimer);

    this.persistenceTimer = setInterval(() => {
      this.persistMetrics().catch((error) => {
        this.logger.warn("Failed to persist tool health metrics", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.PERSISTENCE_INTERVAL);
  }

  /**
   * Persist metrics to database (async, non-blocking)
   * Currently stores in-memory only
   */
  private async persistMetrics(): Promise<void> {
    const metrics = this.getAllHealthMetrics();
    if (metrics.length === 0) return;

    this.logger.debug("Tool health metrics snapshot taken", {
      count: metrics.length,
      averageScore: Math.round(
        metrics.reduce((sum, m) => sum + m.healthScore, 0) / metrics.length
      ),
    });
  }

  /**
   * Cleanup - stop persistence timer
   */
  destroy(): void {
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer);
      this.persistenceTimer = null;
    }
    this.persistMetrics().catch(() => {}); // Final persist attempt
  }

  /**
   * Get or create metrics object
   */
  private getOrCreate(toolName: string): ToolHealthMetrics {
    if (!this.metrics.has(toolName)) {
      this.metrics.set(toolName, {
        toolName,
        totalExecutions: 0,
        successCount: 0,
        failureCount: 0,
        lastSuccess: 0,
        lastFailure: 0,
        averageExecutionTimeMs: 0,
        errorTypes: new Map(),
        healthScore: 50,
      });
    }

    return this.metrics.get(toolName)!;
  }
}
