import { createHash } from "node:crypto";
import type { Logger } from "@ducki/logger";

export type ToolErrorType =
  | "validation"
  | "execution"
  | "timeout"
  | "circuit_breaker"
  | "unknown";

export interface ToolExecutionAttempt {
  toolName: string;
  input: Record<string, unknown>;
  signature: string;
  error: string;
  errorType: ToolErrorType;
  timestamp: number;
  retryCount: number;
}

/**
 * Classifies an error into standard error types
 */
export function classifyError(error: unknown): ToolErrorType {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("validation") || message.includes("Invalid")) {
    return "validation";
  }
  if (message.includes("timeout") || message.includes("Timeout")) {
    return "timeout";
  }
  if (message.includes("circuit")) {
    return "circuit_breaker";
  }

  return "execution";
}

/**
 * Tracks tool execution failures to avoid repeated attempts of the same failing tool
 * with identical inputs within a conversation.
 */
export class ToolErrorTracker {
  private failedSignatures: Map<string, ToolExecutionAttempt> = new Map();
  private readonly logger: Logger;
  private readonly maxRetriesPerSignature = 3;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Creates a unique signature for a tool call
   */
  private createSignature(toolName: string, input: Record<string, unknown>): string {
    const key = `${toolName}:${JSON.stringify(input)}`;
    return createHash("sha256").update(key).digest("hex");
  }

  /**
   * Track a failed tool execution
   */
  track(toolName: string, input: Record<string, unknown>, error: Error): void {
    const sig = this.createSignature(toolName, input);
    const existing = this.failedSignatures.get(sig);

    if (!existing) {
      this.failedSignatures.set(sig, {
        toolName,
        input,
        signature: sig,
        error: error.message,
        errorType: classifyError(error),
        timestamp: Date.now(),
        retryCount: 0,
      });

      this.logger.debug("Tracking tool failure", {
        toolName,
        errorType: classifyError(error),
        signature: sig.substring(0, 8),
      });
    } else {
      existing.retryCount++;
      existing.timestamp = Date.now();
      existing.error = error.message;

      this.logger.debug("Updated tool failure tracking", {
        toolName,
        retryCount: existing.retryCount,
        signature: sig.substring(0, 8),
      });
    }
  }

  /**
   * Determines if a tool call should be retried
   */
  shouldRetry(toolName: string, input: Record<string, unknown>): boolean {
    const sig = this.createSignature(toolName, input);
    const attempt = this.failedSignatures.get(sig);

    if (!attempt) {
      return true; // Never tried before
    }

    // Max retries exceeded
    if (attempt.retryCount >= this.maxRetriesPerSignature) {
      this.logger.warn("Max retries exceeded for tool", {
        toolName,
        retries: attempt.retryCount,
        errorType: attempt.errorType,
      });
      return false;
    }

    // Timeouts are always worth retrying
    if (attempt.errorType === "timeout") {
      return true;
    }

    // Circuit breaker indicates systemic failure - don't retry
    if (attempt.errorType === "circuit_breaker") {
      return false;
    }

    // Validation errors indicate a bug, don't retry
    if (attempt.errorType === "validation") {
      return false;
    }

    // Other errors are worth retrying
    return true;
  }

  /**
   * Get a summary of failed tools for LLM context
   */
  getFailedToolsSummary(): string {
    const entries = Array.from(this.failedSignatures.values());

    if (entries.length === 0) {
      return "";
    }

    const summary = entries
      .map((a) => `${a.toolName}: ${a.error} (${a.retryCount} retry attempts, ${a.errorType})`)
      .join("; ");

    return summary.length > 0
      ? `Previously failed tools in this conversation: ${summary}. Avoiding re-execution of identical calls.`
      : "";
  }

  /**
   * Get all failed attempts
   */
  getAllFailures(): ToolExecutionAttempt[] {
    return Array.from(this.failedSignatures.values());
  }

  /**
   * Get details for a specific tool
   */
  getToolFailureInfo(toolName: string): ToolExecutionAttempt | undefined {
    const failures = this.getAllFailures();
    return failures.find((f) => f.toolName === toolName);
  }

  /**
   * Clear all tracked failures (e.g., for new conversation)
   */
  clear(): void {
    this.failedSignatures.clear();
    this.logger.debug("Tool error tracker cleared");
  }
}
