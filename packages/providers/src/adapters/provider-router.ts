import type { LLMMessage, LLMResponse, GenerateOptions } from "@ducki/shared";
import type { LLMProvider } from "../base.js";
import type { ProviderRouterConfig } from "../adapter-config.js";
import { BaseAdapter } from "./base-adapter.js";

interface ProviderStack {
  primary: LLMProvider;
  fallbacks: LLMProvider[];
}

interface FailoverResult<T> {
  success: boolean;
  data?: T;
  error?: {
    category: string;
    message: string;
    retryable: boolean;
    lastProvider: string;
  };
}

/**
 * Routes LLM requests across multiple providers with intelligent failover.
 *
 * Features:
 * - Automatic failover on errors (retryable errors only)
 * - Provider health tracking
 * - Error classification (some errors don't warrant failover)
 * - Settings-aware configuration
 */
export class ProviderRouter implements LLMProvider {
  readonly name = "provider-router";
  readonly model: string;
  private stack: ProviderStack;
  private errorHistory: Map<string, { count: number; lastError: string; timestamp: number }> = new Map();
  private config: ProviderRouterConfig;

  constructor(primary: LLMProvider, fallbacks: LLMProvider[] = [], config?: Partial<ProviderRouterConfig>) {
    this.stack = { primary, fallbacks };
    this.model = primary.model;

    // Default config
    const defaults: ProviderRouterConfig = {
      maxErrorsPerProvider: 5,
      errorResetWindow: 5 * 60 * 1000, // 5 minutes
      healthCheckInterval: 30000, // 30 seconds
      healthCheckEnabled: true,
      failoverEnabled: true,
      failoverStrategy: "intelligent",
      failoverLogging: true,
      providerPriorities: {
        anthropic: 100,
        gemini: 80,
        bedrock: 60,
      },
    };

    this.config = { ...defaults, ...config };

    if (fallbacks.length === 0) {
      console.warn("[ProviderRouter] No fallback providers configured. Single point of failure!");
    }
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<ProviderRouterConfig>): void {
    this.config = { ...this.config, ...config };
    if (this.config.failoverLogging) {
      console.log("[ProviderRouter] Configuration updated", { config: this.config });
    }
  }

  /**
   * Add a fallback provider
   */
  addFallback(provider: LLMProvider): void {
    this.stack.fallbacks.push(provider);
  }

  /**
   * Check if a provider is healthy based on error history
   */
  private isProviderHealthy(providerName: string): boolean {
    if (!this.config.healthCheckEnabled) return true;

    const history = this.errorHistory.get(providerName);
    if (!history) return true;

    // Reset errors if enough time has passed
    if (Date.now() - history.timestamp > this.config.errorResetWindow) {
      this.errorHistory.delete(providerName);
      return true;
    }

    // Unhealthy if too many errors
    return history.count < this.config.maxErrorsPerProvider;
  }

  /**
   * Record an error for a provider
   */
  private recordError(providerName: string, error: string): void {
    const history = this.errorHistory.get(providerName) ?? { count: 0, lastError: "", timestamp: 0 };
    history.count++;
    history.lastError = error;
    history.timestamp = Date.now();
    this.errorHistory.set(providerName, history);

    if (this.config.failoverLogging) {
      console.log(`[ProviderRouter] Error recorded for ${providerName}:`, {
        count: history.count,
        maxAllowed: this.config.maxErrorsPerProvider,
        error: error.slice(0, 100),
      });
    }
  }

  /**
   * Classify error and determine if failover is appropriate
   */
  private shouldFailover(error: unknown): boolean {
    if (!this.config.failoverEnabled) return false;

    if (!(error instanceof Error)) return true;

    const message = error.message.toLowerCase();

    // Non-retryable errors that shouldn't trigger failover
    const noFailover = [
      "unauthorized", // Auth issue with this provider
      "billing", // Account issue with this provider
      "content policy", // Content rejected by this provider
      "invalid model", // Model not available on this provider
    ];

    for (const pattern of noFailover) {
      if (message.includes(pattern)) {
        return false;
      }
    }

    // Retryable errors warrant failover
    return true;
  }

  /**
   * Get next available provider in stack
   */
  private getNextProvider(): LLMProvider | null {
    // Check if primary is still healthy
    if (this.isProviderHealthy(this.stack.primary.name)) {
      return this.stack.primary;
    }

    // Find first healthy fallback
    for (const fallback of this.stack.fallbacks) {
      if (this.isProviderHealthy(fallback.name)) {
        return fallback;
      }
    }

    return null;
  }

  /**
   * Execute operation with failover support
   */
  private async executeWithFailover<T>(
    operation: (provider: LLMProvider) => Promise<T>,
    operationName: string
  ): Promise<FailoverResult<T>> {
    const allProviders = [this.stack.primary, ...this.stack.fallbacks];
    let lastError: { category: string; message: string; retryable: boolean } | null = null;
    let lastProvider = "";

    for (const provider of allProviders) {
      // Skip unhealthy providers
      if (!this.isProviderHealthy(provider.name)) {
        continue;
      }

      try {
        const result = await operation(provider);
        // Success! Reset error count for this provider
        this.errorHistory.delete(provider.name);
        return { success: true, data: result };
      } catch (error) {
        lastProvider = provider.name;
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Classify error
        const shouldTryNext = this.shouldFailover(error);
        this.recordError(provider.name, errorMessage);

        if (error instanceof Error) {
          const classified = this.classifyError(error);
          lastError = classified;

          if (!shouldTryNext || classified.category === "Unauthorized") {
            // Don't retry - this error is provider-specific
            break;
          }
        }

        // Try next provider
        continue;
      }
    }

    // All providers exhausted or non-retryable error
    return {
      success: false,
      error: {
        category: lastError?.category ?? "ProviderUnavailable",
        message: lastError?.message ?? "No providers available",
        retryable: lastError?.retryable ?? false,
        lastProvider,
      },
    };
  }

  /**
   * Classify error based on message
   */
  private classifyError(error: Error): { category: string; message: string; retryable: boolean } {
    const message = error.message.toLowerCase();

    if (message.includes("rate limit")) {
      return { category: "RateLimited", message: error.message, retryable: true };
    }
    if (message.includes("unauthorized") || message.includes("401")) {
      return { category: "Unauthorized", message: error.message, retryable: false };
    }
    if (message.includes("context") || message.includes("too long")) {
      return { category: "ContextOverflow", message: error.message, retryable: true };
    }
    if (message.includes("billing") || message.includes("402")) {
      return { category: "BillingExhausted", message: error.message, retryable: false };
    }
    if (message.includes("content policy")) {
      return { category: "ContentPolicyViolation", message: error.message, retryable: false };
    }
    if (message.includes("timeout")) {
      return { category: "Timeout", message: error.message, retryable: true };
    }
    if (message.includes("econnrefused")) {
      return { category: "ConnectionError", message: error.message, retryable: true };
    }

    return { category: "Unknown", message: error.message, retryable: true };
  }

  /**
   * Main generate method with failover
   */
  async generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse> {
    const result = await this.executeWithFailover(
      (provider) => provider.generate(messages, options),
      "generate"
    );

    if (result.success && result.data) {
      return result.data;
    }

    throw new Error(
      `[ProviderRouter] ${result.error?.category}: ${result.error?.message} (last provider: ${result.error?.lastProvider})`
    );
  }

  /**
   * Streaming generate with failover
   */
  async generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions,
    onChunk?: (chunk: string) => void
  ): Promise<LLMResponse> {
    const result = await this.executeWithFailover(
      (provider) => provider.generateStream(messages, options, onChunk),
      "generateStream"
    );

    if (result.success && result.data) {
      return result.data;
    }

    throw new Error(
      `[ProviderRouter] ${result.error?.category}: ${result.error?.message} (last provider: ${result.error?.lastProvider})`
    );
  }

  /**
   * Check if any provider is available
   */
  async isAvailable(): Promise<boolean> {
    const allProviders = [this.stack.primary, ...this.stack.fallbacks];

    for (const provider of allProviders) {
      try {
        if (await provider.isAvailable()) {
          return true;
        }
      } catch {
        // Provider not available, continue
      }
    }

    return false;
  }

  /**
   * Check if streaming is supported by current provider
   */
  supportsStreaming(): boolean {
    const current = this.getNextProvider();
    if (!current) return false;
    return current.supportsStreaming();
  }

  /**
   * Get provider health status
   */
  getProviderStatus(): {
    primary: { name: string; healthy: boolean; errors: number };
    fallbacks: Array<{ name: string; healthy: boolean; errors: number }>;
    config: ProviderRouterConfig;
  } {
    return {
      primary: {
        name: this.stack.primary.name,
        healthy: this.isProviderHealthy(this.stack.primary.name),
        errors: this.errorHistory.get(this.stack.primary.name)?.count ?? 0,
      },
      fallbacks: this.stack.fallbacks.map((f) => ({
        name: f.name,
        healthy: this.isProviderHealthy(f.name),
        errors: this.errorHistory.get(f.name)?.count ?? 0,
      })),
      config: this.config,
    };
  }

  /**
   * Reset error history (useful for testing or recovery)
   */
  resetErrorHistory(): void {
    this.errorHistory.clear();
  }
}
