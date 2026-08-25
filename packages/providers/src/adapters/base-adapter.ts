import type { LLMMessage, LLMResponse, GenerateOptions, LLMContent } from "@ducki/shared";
import type { LLMProvider, ProviderOptions } from "../base.js";
import type { AdapterConfig } from "../adapter-config.js";

/**
 * Base adapter for multi-provider LLM support.
 * Provides common functionality for all provider adapters.
 *
 * Each adapter must:
 * 1. Normalize messages to provider-specific format
 * 2. Handle provider-specific configuration
 * 3. Translate errors to standardized format
 * 4. Track token usage accurately
 * 5. Support both streaming and non-streaming
 *
 * Settings-aware: Follows AdapterConfig for runtime tuning
 */
export abstract class BaseAdapter implements LLMProvider {
  abstract readonly name: string;
  readonly model: string;
  protected defaultOptions: GenerateOptions;
  protected baseUrl: string;
  protected apiKey?: string;
  protected config: AdapterConfig;

  constructor(options: ProviderOptions, config?: Partial<AdapterConfig>) {
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.defaultOptions = options.defaultOptions ?? {};

    // Default adapter config
    const defaults: AdapterConfig = {
      timeoutMs: 30000,
      streamTimeoutMs: 60000,
      maxRetries: 3,
      backoffStrategy: "exponential",
      enableExtendedThinking: false,
      temperatureDefault: 1,
      enableStreaming: true,
      enableVision: false,
      logRequests: false,
      logResponses: false,
    };

    this.config = { ...defaults, ...config };
  }

  /**
   * Update adapter config at runtime
   */
  updateConfig(config: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...config };
    if (this.config.logRequests) {
      console.log(`[${this.name}Adapter] Config updated`, { config: this.config });
    }
  }

  /**
   * Get maximum output tokens for this model
   */
  protected abstract getMaxOutputTokens(): number;

  /**
   * Get model family identifier (e.g., 'claude-3.5-sonnet')
   */
  protected abstract getModelFamily(): string;

  /**
   * Check if this model supports extended thinking
   */
  protected supportsExtendedThinking(): boolean {
    return false;
  }

  /**
   * Convert generic LLMMessage to provider-specific format
   */
  protected abstract normalizeMessages(messages: LLMMessage[]): unknown;

  /**
   * Extract system prompt from messages (if provider supports it)
   */
  protected extractSystemPrompt(messages: LLMMessage[]): string | undefined {
    const systemMessage = messages.find((m) => m.role === "system");
    if (!systemMessage || typeof systemMessage.content !== "string") {
      return undefined;
    }
    return systemMessage.content;
  }

  /**
   * Convert LLMContent[] to normalized text content
   */
  protected normalizeContent(content: string | LLMContent[]): string {
    if (typeof content === "string") {
      return content;
    }

    const textParts = content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("\n");

    return textParts;
  }

  /**
   * Merge user options with defaults and adapter config
   */
  protected mergeOptions(options?: GenerateOptions): GenerateOptions {
    const merged = {
      ...this.defaultOptions,
      ...options,
      temperature: options?.temperature ?? this.config.temperatureDefault,
    };

    // Constrain maxTokens to model limits
    if (this.config.maxTokensOverride) {
      merged.maxTokens = this.config.maxTokensOverride;
    } else if (merged.maxTokens) {
      const maxAllowed = this.getMaxOutputTokens();
      merged.maxTokens = Math.min(merged.maxTokens, maxAllowed);
    } else {
      merged.maxTokens = Math.min(this.defaultOptions.maxTokens ?? 1024, this.getMaxOutputTokens());
    }

    return merged;
  }

  /**
   * Classify and standardize provider-specific errors
   */
  protected classifyError(error: unknown): {
    category: string;
    retryable: boolean;
    message: string;
  } {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      // Rate limiting
      if (message.includes("rate limit") || message.includes("429")) {
        return {
          category: "RateLimited",
          retryable: true,
          message: error.message,
        };
      }

      // Authentication
      if (message.includes("unauthorized") || message.includes("401") || message.includes("invalid api key")) {
        return {
          category: "Unauthorized",
          retryable: false,
          message: error.message,
        };
      }

      // Context overflow
      if (
        message.includes("context") ||
        message.includes("too long") ||
        message.includes("max tokens") ||
        message.includes("window")
      ) {
        return {
          category: "ContextOverflow",
          retryable: true,
          message: error.message,
        };
      }

      // Billing
      if (message.includes("billing") || message.includes("credit") || message.includes("402")) {
        return {
          category: "BillingExhausted",
          retryable: false,
          message: error.message,
        };
      }

      // Content policy
      if (message.includes("content policy") || message.includes("blocked")) {
        return {
          category: "ContentPolicyViolation",
          retryable: false,
          message: error.message,
        };
      }

      // Server error
      if (message.includes("5") && message.includes("0") && message.includes("0")) {
        return {
          category: "ProviderError",
          retryable: true,
          message: error.message,
        };
      }

      // Timeout
      if (message.includes("timeout") || message.includes("timed out")) {
        return {
          category: "Timeout",
          retryable: true,
          message: error.message,
        };
      }

      // Connection error
      if (message.includes("econnrefused") || message.includes("connect")) {
        return {
          category: "ConnectionError",
          retryable: true,
          message: error.message,
        };
      }
    }

    return {
      category: "Unknown",
      retryable: true,
      message: String(error),
    };
  }

  /**
   * Estimate tokens in text (naive approximation)
   * Used when provider doesn't return token counts
   */
  protected estimateTokens(text: string): number {
    // Rough approximation: 1 token ≈ 4 characters
    // Provides fallback when provider doesn't return usage
    return Math.ceil(text.length / 4);
  }

  /**
   * Validate that required configuration is present
   */
  protected validateConfiguration(): void {
    if (!this.model) {
      throw new Error(`${this.name}: model not configured`);
    }

    if (!this.baseUrl) {
      throw new Error(`${this.name}: baseUrl not configured`);
    }

    if (!this.apiKey) {
      throw new Error(`${this.name}: apiKey not provided`);
    }
  }

  /**
   * Check if provider is available (connectivity + auth)
   */
  async isAvailable(): Promise<boolean> {
    try {
      this.validateConfiguration();
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: this.model, name: this.model }];
  }

  /**
   * Core generate method - must be implemented by subclasses
   */
  abstract generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse>;

  /**
   * Streaming generate - must be implemented by subclasses
   */
  abstract generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions,
    onChunk?: (chunk: string) => void
  ): Promise<LLMResponse>;

  /**
   * Check if this provider supports streaming
   */
  abstract supportsStreaming(): boolean;
}
