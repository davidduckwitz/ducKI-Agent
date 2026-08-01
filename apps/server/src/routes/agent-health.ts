import type { Router, Request, Response } from "express";

/**
 * Agent Health & Monitoring Routes
 * Provides observability into agent execution health and tool performance
 */
export function setupAgentHealthRoutes(
  router: Router,
  toolHealthMonitor: any,
  circuitBreaker: any
): void {
  /**
   * GET /api/agent-health
   * Returns overall agent health status and metrics
   */
  router.get("/api/agent-health", (req: Request, res: Response) => {
    const toolHealthAll = toolHealthMonitor.getAllHealthMetrics();
    const healthSummary = toolHealthMonitor.getHealthSummary();
    const circuitSummary = circuitBreaker.getHealthSummary();

    const unhealthyTools = toolHealthMonitor.getUnhealthyTools();
    const unhealthyCircuits = circuitBreaker.getUnhealthyTools();

    res.json({
      status: circuitSummary.openCircuits === 0 ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      toolHealth: {
        summary: healthSummary,
        unhealthyTools: unhealthyTools.map((m: any) => ({
          toolName: m.toolName,
          healthScore: m.healthScore,
          totalExecutions: m.totalExecutions,
          successRate: (m.successCount / (m.totalExecutions || 1) * 100).toFixed(1) + "%",
          averageExecutionTimeMs: Math.round(m.averageExecutionTimeMs),
        })),
      },
      circuitBreaker: {
        summary: circuitSummary,
        openCircuits: unhealthyCircuits
          .filter((c: any) => c.status === "open")
          .map((c: any) => ({
            toolName: c.toolName,
            status: c.status,
            failureCount: c.failureCount,
            timeSinceFailureMs: Date.now() - c.lastFailureTime,
          })),
        halfOpenCircuits: unhealthyCircuits
          .filter((c: any) => c.status === "half-open")
          .map((c: any) => ({
            toolName: c.toolName,
            status: c.status,
            successCount: c.successCount,
          })),
      },
      recommendations: generateRecommendations(healthSummary, circuitSummary),
    });
  });

  /**
   * GET /api/agent-health/tools/:toolName
   * Returns detailed health information for a specific tool
   */
  router.get("/api/agent-health/tools/:toolName", (req: Request, res: Response) => {
    const toolName = req.params.toolName as string;
    const health = toolHealthMonitor.getHealth(toolName);

    if (!health) {
      return res.status(404).json({
        error: `No health data for tool '${toolName}'`,
      });
    }

    const circuitStatus = circuitBreaker.getStatus(toolName);
    const errorSummary = toolHealthMonitor.getToolErrorSummary(toolName);

    res.json({
      toolName,
      timestamp: new Date().toISOString(),
      health: {
        healthScore: health.healthScore,
        totalExecutions: health.totalExecutions,
        successCount: health.successCount,
        failureCount: health.failureCount,
        successRate: (health.successCount / (health.totalExecutions || 1) * 100).toFixed(1) + "%",
        averageExecutionTimeMs: Math.round(health.averageExecutionTimeMs),
        lastSuccess: health.lastSuccess > 0 ? new Date(health.lastSuccess).toISOString() : "never",
        lastFailure: health.lastFailure > 0 ? new Date(health.lastFailure).toISOString() : "never",
      },
      circuitBreaker: {
        status: circuitStatus.status,
        failureCount: circuitStatus.failureCount,
        consecutiveSuccesses: circuitStatus.consecutiveSuccesses,
        canExecute: circuitStatus.status !== "open",
      },
      errors: errorSummary.map((e: any) => ({
        type: e.errorType,
        count: e.count,
      })),
      recommendations: generateToolRecommendations(toolName, health, circuitStatus),
    });
  });

  /**
   * GET /api/agent-health/metrics
   * Returns raw metrics for monitoring/dashboard integration
   */
  router.get("/api/agent-health/metrics", (req: Request, res: Response) => {
    const toolMetrics = toolHealthMonitor.getAllHealthMetrics();
    const circuitCircuits = circuitBreaker.getUnhealthyTools();

    res.json({
      timestamp: new Date().toISOString(),
      tools: toolMetrics.map((m: any) => ({
        name: m.toolName,
        executions: m.totalExecutions,
        successes: m.successCount,
        failures: m.failureCount,
        score: m.healthScore,
        avgTimeMs: Math.round(m.averageExecutionTimeMs),
      })),
      circuits: circuitCircuits.map((c: any) => ({
        tool: c.toolName,
        status: c.status,
        failures: c.failureCount,
      })),
    });
  });
}

/**
 * Generate recommendations based on health metrics
 */
function generateRecommendations(
  healthSummary: any,
  circuitSummary: any
): string[] {
  const recommendations: string[] = [];

  if (circuitSummary.openCircuits > 0) {
    recommendations.push(
      `⚠️ ${circuitSummary.openCircuits} tool(s) have circuit breakers open - waiting for recovery`
    );
  }

  if (healthSummary.unhealthyTools > 0) {
    recommendations.push(
      `⚠️ ${healthSummary.unhealthyTools} tool(s) below health threshold - monitor or restart`
    );
  }

  if (circuitSummary.halfOpenCircuits > 0) {
    recommendations.push(
      `ℹ️ ${circuitSummary.halfOpenCircuits} tool(s) in half-open recovery state`
    );
  }

  if (healthSummary.unhealthyTools === 0 && circuitSummary.openCircuits === 0) {
    recommendations.push("✅ All tools healthy - no action needed");
  }

  return recommendations;
}

/**
 * Generate tool-specific recommendations
 */
function generateToolRecommendations(
  toolName: string,
  health: any,
  circuitStatus: any
): string[] {
  const recommendations: string[] = [];

  if (circuitStatus.status === "open") {
    recommendations.push("🔴 Circuit breaker is OPEN - tool is blocked to prevent cascading failures");
    recommendations.push("ℹ️ Circuit will automatically test recovery after 1 minute");
  }

  if (circuitStatus.status === "half-open") {
    recommendations.push("🟡 Circuit breaker in HALF-OPEN - testing recovery with limited attempts");
  }

  if (health.healthScore < 50) {
    recommendations.push("⚠️ Tool health is CRITICAL - consider troubleshooting or fallback");
  } else if (health.healthScore < 70) {
    recommendations.push("⚠️ Tool health is DEGRADED - monitor for further deterioration");
  }

  if (health.averageExecutionTimeMs > 10000) {
    recommendations.push("⏱️ Tool has HIGH latency (>10s average) - may impact user experience");
  }

  if (health.totalExecutions > 100 && health.healthScore > 90) {
    recommendations.push("✅ Tool is performing WELL - stable and reliable");
  }

  return recommendations;
}
