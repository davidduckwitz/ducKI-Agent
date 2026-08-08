import type { LLMMessage } from "@ducki/shared";

/**
 * Model-specific token limits and cost information
 */
export interface ModelTokenConfig {
  model: string;
  maxTokens: number;
  inputTokensPerMillion: number; // Cost in USD
  outputTokensPerMillion: number; // Cost in USD
  estimatedTokensPerMessage: number; // Average overhead per message
  estimatedTokensPerWord: number; // Average word-to-token ratio
}

/**
 * Token counting for different LLM models
 *
 * Provides:
 * - Approximate token counting for various models
 * - Context budget calculation
 * - Cost estimation
 * - Memory-aware pruning decisions
 */
export class TokenCounter {
  private static readonly MODEL_CONFIGS: Map<string, ModelTokenConfig> = new Map([
    // Anthropic Claude models — current generation (pricing per 1M tokens, USD)
    [
      "claude-opus-5",
      {
        model: "claude-opus-5",
        maxTokens: 1000000,
        inputTokensPerMillion: 5.0,
        outputTokensPerMillion: 25.0,
        estimatedTokensPerMessage: 50,
        estimatedTokensPerWord: 0.33,
      },
    ],
    [
      "claude-sonnet-5",
      {
        model: "claude-sonnet-5",
        maxTokens: 1000000,
        inputTokensPerMillion: 3.0,
        outputTokensPerMillion: 15.0,
        estimatedTokensPerMessage: 50,
        estimatedTokensPerWord: 0.33,
      },
    ],
    [
      "claude-haiku-4-5",
      {
        model: "claude-haiku-4-5",
        maxTokens: 200000,
        inputTokensPerMillion: 1.0,
        outputTokensPerMillion: 5.0,
        estimatedTokensPerMessage: 50,
        estimatedTokensPerWord: 0.33,
      },
    ],
    [
      "claude-fable-5",
      {
        model: "claude-fable-5",
        maxTokens: 1000000,
        inputTokensPerMillion: 10.0,
        outputTokensPerMillion: 50.0,
        estimatedTokensPerMessage: 50,
        estimatedTokensPerWord: 0.33,
      },
    ],
    // Anthropic Claude models — legacy
    [
      "claude-3-5-sonnet",
      {
        model: "claude-3-5-sonnet-20241022",
        maxTokens: 200000,
        inputTokensPerMillion: 3.0,
        outputTokensPerMillion: 15.0,
        estimatedTokensPerMessage: 50,
        estimatedTokensPerWord: 0.33,
      },
    ],
    [
      "claude-3-opus",
      {
        model: "claude-3-opus-20240229",
        maxTokens: 200000,
        inputTokensPerMillion: 15.0,
        outputTokensPerMillion: 75.0,
        estimatedTokensPerMessage: 50,
        estimatedTokensPerWord: 0.33,
      },
    ],
    [
      "claude-3-haiku",
      {
        model: "claude-3-haiku-20240307",
        maxTokens: 200000,
        inputTokensPerMillion: 0.8,
        outputTokensPerMillion: 4.0,
        estimatedTokensPerMessage: 50,
        estimatedTokensPerWord: 0.33,
      },
    ],

    // Google Gemini models
    [
      "gemini-2.0-flash",
      {
        model: "gemini-2.0-flash",
        maxTokens: 1000000,
        inputTokensPerMillion: 0.075,
        outputTokensPerMillion: 0.3,
        estimatedTokensPerMessage: 50,
        estimatedTokensPerWord: 0.33,
      },
    ],
    [
      "gemini-1.5-pro",
      {
        model: "gemini-1.5-pro",
        maxTokens: 1000000,
        inputTokensPerMillion: 1.25,
        outputTokensPerMillion: 5.0,
        estimatedTokensPerMessage: 50,
        estimatedTokensPerWord: 0.33,
      },
    ],

    // OpenAI models
    [
      "gpt-4o",
      {
        model: "gpt-4o",
        maxTokens: 128000,
        inputTokensPerMillion: 2.5,
        outputTokensPerMillion: 10.0,
        estimatedTokensPerMessage: 50,
        estimatedTokensPerWord: 0.33,
      },
    ],
    [
      "gpt-4-turbo",
      {
        model: "gpt-4-turbo-preview",
        maxTokens: 128000,
        inputTokensPerMillion: 10.0,
        outputTokensPerMillion: 30.0,
        estimatedTokensPerMessage: 50,
        estimatedTokensPerWord: 0.33,
      },
    ],

    // AWS Bedrock models
    [
      "anthropic.claude-3-sonnet",
      {
        model: "anthropic.claude-3-sonnet-20240229-v1:0",
        maxTokens: 200000,
        inputTokensPerMillion: 3.0,
        outputTokensPerMillion: 15.0,
        estimatedTokensPerMessage: 50,
        estimatedTokensPerWord: 0.33,
      },
    ],

    // Local models (estimate)
    [
      "local",
      {
        model: "local-model",
        maxTokens: 4096,
        inputTokensPerMillion: 0,
        outputTokensPerMillion: 0,
        estimatedTokensPerMessage: 50,
        estimatedTokensPerWord: 0.33,
      },
    ],
  ]);

  /**
   * Get model config by model name (fuzzy matching)
   */
  static getModelConfig(modelName: string): ModelTokenConfig {
    // Try exact match first
    if (this.MODEL_CONFIGS.has(modelName)) {
      return this.MODEL_CONFIGS.get(modelName)!;
    }

    // Try fuzzy match
    const normalized = modelName.toLowerCase();
    for (const [key, config] of this.MODEL_CONFIGS.entries()) {
      if (normalized.includes(key.toLowerCase()) || key.toLowerCase().includes(normalized)) {
        return config;
      }
    }

    // Default to local model
    return this.MODEL_CONFIGS.get("local")!;
  }

  /**
   * Count tokens in a message
   * Approximation based on word count (not using external tokenizer)
   */
  static countMessageTokens(message: LLMMessage, modelName: string): number {
    const config = this.getModelConfig(modelName);
    let tokenCount = config.estimatedTokensPerMessage;

    // Count tokens in content
    if (message.content && typeof message.content === "string") {
      const wordCount = message.content.split(/\s+/).length;
      tokenCount += Math.ceil(wordCount * config.estimatedTokensPerWord);
    }

    // Count tokens in tool calls/responses
    if ("toolUse" in message && message.toolUse) {
      const toolContent = JSON.stringify(message.toolUse);
      const wordCount = toolContent.split(/\s+/).length;
      tokenCount += Math.ceil(wordCount * config.estimatedTokensPerWord);
    }

    return tokenCount;
  }

  /**
   * Count total tokens in a message array
   */
  static countConversationTokens(messages: LLMMessage[], modelName: string): number {
    return messages.reduce((total, msg) => total + this.countMessageTokens(msg, modelName), 0);
  }

  /**
   * Calculate context budget
   */
  static getContextBudget(
    modelName: string,
    options?: {
      reserveOutputTokens?: number; // Reserve space for response
      systemPromptTokens?: number; // Account for system prompt
    }
  ): { maxInputTokens: number; reservedTokens: number; availableTokens: number } {
    const config = this.getModelConfig(modelName);
    const reserveOutput = options?.reserveOutputTokens ?? 4000;
    const systemPrompt = options?.systemPromptTokens ?? 500;

    const maxInputTokens = config.maxTokens - reserveOutput;
    const reservedTokens = systemPrompt;
    const availableTokens = maxInputTokens - reservedTokens;

    return { maxInputTokens, reservedTokens, availableTokens };
  }

  /**
   * Estimate cost for a message
   */
  static estimateCost(
    messages: LLMMessage[],
    modelName: string,
    outputTokensGenerated?: number
  ): { inputCost: number; outputCost: number; totalCost: number } {
    const config = this.getModelConfig(modelName);
    const inputTokens = this.countConversationTokens(messages, modelName);
    const outputTokens = outputTokensGenerated ?? 1000;

    const inputCost = (inputTokens / 1000000) * config.inputTokensPerMillion;
    const outputCost = (outputTokens / 1000000) * config.outputTokensPerMillion;
    const totalCost = inputCost + outputCost;

    return { inputCost, outputCost, totalCost };
  }

  /**
   * Estimate cost in USD directly from token counts (no message array needed).
   * Used by the cost governor, which accumulates the provider's reported
   * per-call usage. Local/unknown models resolve to the zero-cost "local" config.
   */
  static estimateCostFromTokens(
    modelName: string,
    inputTokens: number,
    outputTokens: number
  ): { inputCost: number; outputCost: number; totalCost: number } {
    const config = this.getModelConfig(modelName);
    const inputCost = (inputTokens / 1000000) * config.inputTokensPerMillion;
    const outputCost = (outputTokens / 1000000) * config.outputTokensPerMillion;
    return { inputCost, outputCost, totalCost: inputCost + outputCost };
  }

  /**
   * Check if message fits in available context
   */
  static fitsInContext(
    messages: LLMMessage[],
    newMessage: LLMMessage,
    modelName: string
  ): boolean {
    const budget = this.getContextBudget(modelName);
    const currentTokens = this.countConversationTokens(messages, modelName);
    const newTokens = this.countMessageTokens(newMessage, modelName);

    return currentTokens + newTokens <= budget.availableTokens;
  }

  /**
   * Get optimal max message count for staying under budget
   */
  static getMaxMessageCount(modelName: string, averageMessageTokens?: number): number {
    const config = this.getModelConfig(modelName);
    const avgTokens = averageMessageTokens ?? 200;
    const budget = this.getContextBudget(modelName);

    return Math.max(1, Math.floor(budget.availableTokens / avgTokens));
  }
}
