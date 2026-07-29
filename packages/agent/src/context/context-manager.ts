import type { LLMMessage } from "@ducki/shared";
import { TokenCounter, type ModelTokenConfig } from "./token-counter.js";

/**
 * Strategy for pruning messages when over budget
 */
export type PruningStrategy = "oldest-first" | "least-important" | "summary-based" | "sliding-window";

/**
 * Configuration for context management
 */
export interface ContextManagerConfig {
  pruningStrategy: PruningStrategy;
  keepSystemMessage: boolean; // Always keep first message if it's a system prompt
  keepRecentMessages: number; // Number of recent messages to always keep
  minMessagesToKeep: number; // Absolute minimum message count
  compressionThreshold: number; // Percentage at which to start compression (e.g., 80)
  summaryLength: number; // Approximate tokens for summary
}

/**
 * Manages conversation context with intelligent pruning
 *
 * Features:
 * - Token-based context budgeting
 * - Multiple pruning strategies
 * - Smart message filtering
 * - Summary generation hints
 * - Memory-aware optimization
 */
export class ContextManager {
  private modelName: string;
  private config: ContextManagerConfig;
  private messages: LLMMessage[] = [];

  constructor(
    modelName: string,
    config?: Partial<ContextManagerConfig>
  ) {
    this.modelName = modelName;
    this.config = {
      pruningStrategy: "sliding-window",
      keepSystemMessage: true,
      keepRecentMessages: 5,
      minMessagesToKeep: 3,
      compressionThreshold: 80,
      summaryLength: 500,
      ...config,
    };
  }

  /**
   * Add messages to context
   */
  addMessages(messages: LLMMessage[]): void {
    this.messages.push(...messages);
  }

  /**
   * Get current messages
   */
  getMessages(): LLMMessage[] {
    return this.messages;
  }

  /**
   * Get message count
   */
  getMessageCount(): number {
    return this.messages.length;
  }

  /**
   * Get current token usage
   */
  getTokenUsage(): {
    currentTokens: number;
    maxTokens: number;
    percentageUsed: number;
    remainingTokens: number;
  } {
    const budget = TokenCounter.getContextBudget(this.modelName);
    const currentTokens = TokenCounter.countConversationTokens(this.messages, this.modelName);
    const percentageUsed = (currentTokens / budget.availableTokens) * 100;

    return {
      currentTokens,
      maxTokens: budget.availableTokens,
      percentageUsed,
      remainingTokens: Math.max(0, budget.availableTokens - currentTokens),
    };
  }

  /**
   * Check if message fits in current context
   */
  canAddMessage(message: LLMMessage): boolean {
    return TokenCounter.fitsInContext(this.messages, message, this.modelName);
  }

  /**
   * Ensure messages fit within context budget
   * Returns pruned message array
   */
  optimizeForContext(): LLMMessage[] {
    const usage = this.getTokenUsage();

    // No optimization needed
    if (usage.percentageUsed < this.config.compressionThreshold) {
      return this.messages;
    }

    // Prune based on strategy
    switch (this.config.pruningStrategy) {
      case "oldest-first":
        return this.pruneOldestFirst();
      case "least-important":
        return this.pruneLeastImportant();
      case "summary-based":
        return this.pruneSummaryBased();
      case "sliding-window":
      default:
        return this.pruneSlidingWindow();
    }
  }

  /**
   * Prune oldest messages first (simple FIFO)
   */
  private pruneOldestFirst(): LLMMessage[] {
    let pruned = [...this.messages];
    const budget = TokenCounter.getContextBudget(this.modelName);

    // Protect system message
    const systemMessage = this.config.keepSystemMessage && pruned.length > 0 ? pruned[0] : null;
    const protectedMessages = systemMessage ? 1 : 0;

    // Protect recent messages
    const minKeepIndex = Math.max(
      protectedMessages,
      pruned.length - this.config.keepRecentMessages
    );

    while (pruned.length > this.config.minMessagesToKeep) {
      const tokenCount = TokenCounter.countConversationTokens(pruned, this.modelName);
      if (tokenCount <= budget.availableTokens) break;

      // Find oldest removable message
      let removed = false;
      for (let i = protectedMessages; i < minKeepIndex; i++) {
        if (i >= 0 && i < pruned.length) {
          pruned.splice(i, 1);
          removed = true;
          break;
        }
      }

      if (!removed) break;
    }

    this.messages = pruned;
    return pruned;
  }

  /**
   * Prune least important messages
   * (Remove messages without tool use/important info)
   */
  private pruneLeastImportant(): LLMMessage[] {
    let pruned = [...this.messages];
    const budget = TokenCounter.getContextBudget(this.modelName);

    // Score messages by importance
    const scored = pruned.map((msg, idx) => ({
      msg,
      idx,
      score: this.scoreMessageImportance(msg, idx, pruned.length),
    }));

    // Sort by importance (ascending)
    scored.sort((a, b) => a.score - b.score);

    // Remove lowest scoring messages until we fit
    for (const { idx } of scored) {
      if (pruned.length <= this.config.minMessagesToKeep) break;

      const tokenCount = TokenCounter.countConversationTokens(pruned, this.modelName);
      if (tokenCount <= budget.availableTokens) break;

      // Remove by original index
      pruned = pruned.filter((_, i) => i !== idx);
    }

    this.messages = pruned;
    return pruned;
  }

  /**
   * Score a message's importance
   */
  private scoreMessageImportance(msg: LLMMessage, index: number, total: number): number {
    let score = 0;

    // Recent messages are more important
    score += (index / total) * 100;

    // Messages with tool use are important
    if ("toolUse" in msg && msg.toolUse) score += 50;

    // System messages are very important
    if (msg.role === "system") score += 100;

    // Long messages are more likely to have important info
    const contentLength = msg.content?.length ?? 0;
    score += Math.min(contentLength / 100, 20);

    return score;
  }

  /**
   * Prune using summary: replace old messages with summary
   */
  private pruneSummaryBased(): LLMMessage[] {
    let pruned = [...this.messages];
    const budget = TokenCounter.getContextBudget(this.modelName);

    // Keep system message + recent messages
    const keepCount = this.config.keepRecentMessages;
    if (pruned.length <= keepCount + 1) return pruned;

    // Find cutoff point for summary
    let summaryEndIdx = pruned.length - keepCount - 1;
    const messagesToSummarize = pruned.slice(1, summaryEndIdx);

    if (messagesToSummarize.length === 0) return pruned;

    // Create summary message
    const summaryContent = this.generateSummaryHint(messagesToSummarize);
    const summaryMessage: LLMMessage = {
      role: "system",
      content: `[CONTEXT SUMMARY]\n${summaryContent}\n[END SUMMARY]`,
    };

    // Replace summarized messages with summary
    const firstMsg = pruned[0];
    if (firstMsg) {
      pruned = [
        firstMsg,
        summaryMessage,
        ...pruned.slice(summaryEndIdx),
      ];
    }

    // Verify we fit
    let tokenCount = TokenCounter.countConversationTokens(pruned, this.modelName);
    if (tokenCount > budget.availableTokens) {
      // If still over, fall back to sliding window
      return this.pruneSlidingWindow();
    }

    this.messages = pruned;
    return pruned;
  }

  /**
   * Prune using sliding window: keep first and last N messages
   */
  private pruneSlidingWindow(): LLMMessage[] {
    let pruned = [...this.messages];
    const budget = TokenCounter.getContextBudget(this.modelName);
    const keepRecent = this.config.keepRecentMessages;

    // Simple approach: keep first + last N
    if (pruned.length <= keepRecent + 2) return pruned;

    const first = pruned[0];
    const last = pruned.slice(-keepRecent);

    if (first) {
      pruned = [first, ...last];
    } else {
      pruned = [...last];
    }

    // Verify we fit
    let tokenCount = TokenCounter.countConversationTokens(pruned, this.modelName);

    // If still over, remove from middle
    while (tokenCount > budget.availableTokens && pruned.length > this.config.minMessagesToKeep) {
      // Remove from middle (not first or last)
      if (pruned.length > 2) {
        pruned.splice(Math.floor(pruned.length / 2), 1);
        tokenCount = TokenCounter.countConversationTokens(pruned, this.modelName);
      } else {
        break;
      }
    }

    this.messages = pruned;
    return pruned;
  }

  /**
   * Generate a summary hint for messages
   */
  private generateSummaryHint(messages: LLMMessage[]): string {
    const lines: string[] = [];

    // Collect key information
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const userMessages = messages.filter((m) => m.role === "user");
    const toolMessages = messages.filter((m) => "toolUse" in m && m.toolUse);

    lines.push(`Messages summary: ${messages.length} messages processed`);
    lines.push(`- User queries: ${userMessages.length}`);
    lines.push(`- Assistant responses: ${assistantMessages.length}`);
    lines.push(`- Tool calls: ${toolMessages.length}`);

    // Collect topics from user messages
    const topics = new Set<string>();
    userMessages.forEach((msg) => {
      if (msg.content && typeof msg.content === "string") {
        const words = msg.content.split(/\s+/);
        words.slice(0, 5).forEach((word: string) => {
          if (word.length > 4) topics.add(word.toLowerCase());
        });
      }
    });

    if (topics.size > 0) {
      lines.push(`- Topics discussed: ${Array.from(topics).slice(0, 5).join(", ")}`);
    }

    return lines.join("\n");
  }

  /**
   * Get recommendations for optimization
   */
  getOptimizationRecommendations(): {
    shouldOptimize: boolean;
    reason: string;
    currentStrategy: string;
    messagesAfterOptimization: number;
  } {
    const usage = this.getTokenUsage();
    const optimized = this.optimizeForContext();

    return {
      shouldOptimize: usage.percentageUsed > this.config.compressionThreshold,
      reason:
        usage.percentageUsed > this.config.compressionThreshold
          ? `Context usage at ${usage.percentageUsed.toFixed(1)}% (threshold: ${this.config.compressionThreshold}%)`
          : "Context usage is optimal",
      currentStrategy: this.config.pruningStrategy,
      messagesAfterOptimization: optimized.length,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ContextManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Clear all messages
   */
  clear(): void {
    this.messages = [];
  }

  /**
   * Reset to initial state
   */
  reset(messages?: LLMMessage[]): void {
    this.messages = messages ?? [];
  }
}
