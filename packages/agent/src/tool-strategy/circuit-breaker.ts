import type { Logger } from "@ducki/logger";

export type CircuitStatus = "closed" | "open" | "half-open";

export interface CircuitBreakerState {
  toolName: string;
  status: CircuitStatus;
  failureCount: number;
  lastFailureTime: number;
  successCount: number;
  consecutiveSuccesses: number;
}

/**
 * Tool Circuit Breaker - prevents repeated execution of failing tools
 * States:
 * - closed: healthy, tool can be executed
 * - open: broken, tool won't be executed (prevent cascading failures)
 * - half-open: testing recovery, limited attempts allowed
 */
export class ToolCircuitBreaker {
  private breakers: Map<string, CircuitBreakerState> = new Map();
  private readonly logger: Logger;

  // Configuration
  private readonly FAILURE_THRESHOLD = 5; // 5 failures → open
  private readonly HALF_OPEN_TIMEOUT = 60000; // 1 min before trying half-open
  private readonly HALF_OPEN_SUCCESS_NEEDED = 2; // 2 successes to close
  private readonly MAX_HALF_OPEN_ATTEMPTS = 3; // Max attempts in half-open state

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Check if tool can be executed
   */
  canExecute(toolName: string): boolean {
    const breaker = this.getOrCreate(toolName);

    if (breaker.status === "closed") {
      return true; // All good
    }

    if (breaker.status === "open") {
      // Check if enough time has passed to test recovery
      const timeSinceFailure = Date.now() - breaker.lastFailureTime;
      if (timeSinceFailure > this.HALF_OPEN_TIMEOUT) {
        breaker.status = "half-open";
        breaker.successCount = 0;
        breaker.consecutiveSuccesses = 0;
        this.logger.info("Circuit breaker transitioned to half-open", {
          toolName,
          timeSinceFailureMs: timeSinceFailure,
        });
        return true; // Allow test attempt
      }

      this.logger.warn("Circuit breaker is open, blocking tool execution", {
        toolName,
        failureCount: breaker.failureCount,
        timeSinceFailureMs: timeSinceFailure,
        reopensInMs: this.HALF_OPEN_TIMEOUT - timeSinceFailure,
      });
      return false;
    }

    // half-open: limited attempts
    if (breaker.successCount < this.MAX_HALF_OPEN_ATTEMPTS) {
      return true; // Allow test attempt
    }

    this.logger.warn("Half-open state max attempts reached", {
      toolName,
      attempts: breaker.successCount,
    });
    return false;
  }

  /**
   * Record tool execution result
   */
  recordResult(toolName: string, success: boolean): void {
    const breaker = this.getOrCreate(toolName);

    if (success) {
      if (breaker.status === "half-open") {
        breaker.consecutiveSuccesses++;
        breaker.successCount++;

        if (breaker.consecutiveSuccesses >= this.HALF_OPEN_SUCCESS_NEEDED) {
          breaker.status = "closed";
          breaker.failureCount = 0;
          this.logger.info("Circuit breaker recovered to closed", {
            toolName,
            consecutiveSuccesses: breaker.consecutiveSuccesses,
          });
        }
      } else if (breaker.status === "closed") {
        // Reset failure counter on success
        breaker.failureCount = 0;
      }
    } else {
      // Tool failed
      breaker.failureCount++;
      breaker.lastFailureTime = Date.now();
      breaker.consecutiveSuccesses = 0;

      if (breaker.failureCount >= this.FAILURE_THRESHOLD) {
        breaker.status = "open";
        this.logger.warn("Circuit breaker tripped to open", {
          toolName,
          failureCount: breaker.failureCount,
          threshold: this.FAILURE_THRESHOLD,
        });
      }
    }
  }

  /**
   * Get current state of a tool's circuit breaker
   */
  getStatus(toolName: string): CircuitBreakerState {
    return this.getOrCreate(toolName);
  }

  /**
   * Get all tools with open or half-open circuits
   */
  getUnhealthyTools(): CircuitBreakerState[] {
    return Array.from(this.breakers.values()).filter(
      (b) => b.status === "open" || b.status === "half-open"
    );
  }

  /**
   * Reset all circuit breakers (e.g., on conversation restart)
   */
  resetAll(): void {
    this.breakers.clear();
    this.logger.info("All circuit breakers reset");
  }

  /**
   * Reset specific tool's circuit breaker
   */
  reset(toolName: string): void {
    this.breakers.delete(toolName);
    this.logger.info("Circuit breaker reset for tool", { toolName });
  }

  /**
   * Get or create breaker state for tool
   */
  private getOrCreate(toolName: string): CircuitBreakerState {
    if (!this.breakers.has(toolName)) {
      this.breakers.set(toolName, {
        toolName,
        status: "closed",
        failureCount: 0,
        lastFailureTime: 0,
        successCount: 0,
        consecutiveSuccesses: 0,
      });
    }

    return this.breakers.get(toolName)!;
  }

  /**
   * Get health summary for monitoring
   */
  getHealthSummary(): {
    totalTools: number;
    healthyTools: number;
    openCircuits: number;
    halfOpenCircuits: number;
  } {
    const unhealthy = this.getUnhealthyTools();
    const open = unhealthy.filter((b) => b.status === "open").length;
    const halfOpen = unhealthy.filter((b) => b.status === "half-open").length;

    return {
      totalTools: this.breakers.size,
      healthyTools: this.breakers.size - unhealthy.length,
      openCircuits: open,
      halfOpenCircuits: halfOpen,
    };
  }
}
