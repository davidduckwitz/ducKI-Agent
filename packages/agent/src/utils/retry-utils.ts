import type { EventEmitterV2 } from "../events/index.js";
import type { Logger } from "@ducki/logger";

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30000,
  jitterMs: 100,
};

/**
 * Delays execution for specified milliseconds
 */
export async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries a function with exponential backoff.
 * Delay increases as: base * 2^(attempt-1) + random jitter, capped at maxDelayMs
 *
 * @example
 * const result = await retryWithBackoff(
 *   () => riskyOperation(),
 *   DEFAULT_RETRY_CONFIG,
 *   { logger, eventEmitter }
 * );
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  context: { logger?: Logger; eventEmitter?: EventEmitterV2 }
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < config.maxAttempts) {
        const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt - 1);
        const jitter = Math.random() * config.jitterMs;
        const delayMs = Math.min(exponentialDelay + jitter, config.maxDelayMs);

        context.eventEmitter?.emitEvent({
          type: "guardrail",
          message: `Retrying with backoff (attempt ${attempt}/${config.maxAttempts})`,
          data: {
            type: "retry_backoff",
            attempt,
            maxAttempts: config.maxAttempts,
            delayMs: Math.round(delayMs),
            reason: lastError.message,
          },
          timestamp: new Date().toISOString(),
        });

        context.logger?.debug("Retrying with backoff", {
          attempt,
          delayMs: Math.round(delayMs),
          error: lastError.message,
        });

        await delay(delayMs);
      } else {
        context.logger?.warn("Max retry attempts reached", {
          maxAttempts: config.maxAttempts,
          error: lastError.message,
        });
      }
    }
  }

  throw lastError;
}

/**
 * Adjusts retry config timeout based on context compression level
 */
export function adjustTimeoutForCompression(
  baseTimeoutMs: number,
  skillMode: "full" | "compact" | "minimal"
): number {
  const adjustments: Record<typeof skillMode, number> = {
    full: 0,
    compact: 30000, // +30s for compact
    minimal: 60000, // +60s for minimal
  };

  return baseTimeoutMs + (adjustments[skillMode] ?? 0);
}
