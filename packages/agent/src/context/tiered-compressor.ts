import type { LLMProvider } from "@ducki/providers";
import type { LLMMessage } from "@ducki/shared";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import { TokenCounter } from "./token-counter.js";

/**
 * Tiered Context Compressor
 *
 * Applies progressively more aggressive compression strategies at different
 * context usage levels, similar to hermes-agent's 50%/85% thresholds:
 *
 *  - Tier 0 (< 50%): No compression needed
 *  - Tier 1 (50-70%): Light prune — remove old tool results, keep assistant text
 *  - Tier 2 (70-85%): Aggressive compress — summarize older messages via LLM
 *  - Tier 3 (> 85%): Emergency drop — keep only the most recent N messages
 *
 * Each tier is strictly more aggressive than the last, ensuring the context
 * fits within budget while preserving as much useful information as possible.
 */

export type CompressionTier = 0 | 1 | 2 | 3;

export interface CompressionDecision {
  tier: CompressionTier;
  reason: string;
  messagesBefore: number;
  messagesAfter: number;
  tokensSaved: number;
}

export interface TieredCompressorConfig {
  /** Model name for token estimation. */
  modelName: string;
  /** Percentage thresholds for each tier transition. Defaults: [50, 70, 85]. */
  thresholds?: [number, number, number];
  /** Maximum messages to keep in Tier 3 emergency mode. Default: 10. */
  emergencyKeepCount?: number;
  /** How many recent messages to always preserve. Default: 5. */
  preserveRecentCount?: number;
}

const DEFAULT_THRESHOLDS: [number, number, number] = [50, 70, 85];

export class TieredContextCompressor {
  private logger: Logger;
  private readonly thresholds: [number, number, number];
  private readonly emergencyKeepCount: number;
  private readonly preserveRecentCount: number;
  private readonly modelName: string;

  constructor(
    private readonly provider: LLMProvider,
    config: TieredCompressorConfig
  ) {
    this.logger = getRootLogger().child("TieredCompressor");
    this.modelName = config.modelName;
    this.thresholds = config.thresholds ?? DEFAULT_THRESHOLDS;
    this.emergencyKeepCount = config.emergencyKeepCount ?? 10;
    this.preserveRecentCount = config.preserveRecentCount ?? 5;
  }

  /**
   * Determine which compression tier is needed for the given messages.
   */
  getCompressionTier(messages: LLMMessage[]): CompressionTier {
    const budget = TokenCounter.getContextBudget(this.modelName);
    const currentTokens = TokenCounter.countConversationTokens(messages, this.modelName);
    const usagePercent = (currentTokens / budget.availableTokens) * 100;

    if (usagePercent >= this.thresholds[2]) return 3;
    if (usagePercent >= this.thresholds[1]) return 2;
    if (usagePercent >= this.thresholds[0]) return 1;
    return 0;
  }

  /**
   * Get the current usage percentage.
   */
  getUsagePercent(messages: LLMMessage[]): number {
    const budget = TokenCounter.getContextBudget(this.modelName);
    const currentTokens = TokenCounter.countConversationTokens(messages, this.modelName);
    return (currentTokens / budget.availableTokens) * 100;
  }

  /**
   * Apply the appropriate compression tier to the messages.
   * Returns the compressed messages and a decision record.
   */
  async compress(messages: LLMMessage[]): Promise<{
    messages: LLMMessage[];
    decision: CompressionDecision;
  }> {
    const tier = this.getCompressionTier(messages);

    if (tier === 0) {
      return {
        messages,
        decision: {
          tier: 0,
          reason: "Context usage below threshold — no compression needed",
          messagesBefore: messages.length,
          messagesAfter: messages.length,
          tokensSaved: 0,
        },
      };
    }

    const tokensBefore = TokenCounter.countConversationTokens(messages, this.modelName);

    let result: LLMMessage[];
    let reason: string;

    switch (tier) {
      case 1:
        ({ messages: result, reason } = await this.tierLightPrune(messages));
        break;
      case 2:
        ({ messages: result, reason } = await this.tierAggressiveCompress(messages));
        break;
      case 3:
        ({ messages: result, reason } = await this.tierEmergencyDrop(messages));
        break;
      default:
        return { messages, decision: { tier: 0, reason: "Unknown tier", messagesBefore: messages.length, messagesAfter: messages.length, tokensSaved: 0 } };
    }

    const tokensAfter = TokenCounter.countConversationTokens(result, this.modelName);

    const decision: CompressionDecision = {
      tier,
      reason,
      messagesBefore: messages.length,
      messagesAfter: result.length,
      tokensSaved: tokensBefore - tokensAfter,
    };

    this.logger.info("[TieredCompressor] Compression applied", {
      tier,
      usagePercent: this.getUsagePercent(messages).toFixed(1) + "%",
      messagesBefore: decision.messagesBefore,
      messagesAfter: decision.messagesAfter,
      tokensSaved: decision.tokensSaved,
    });

    return { messages: result, decision };
  }

  // ── Tier 1: Light Prune ────────────────────────────────────────────────
  // Remove old tool results and system messages, keep assistant text.
  // Cheap (no LLM call), preserves recent context.
  private async tierLightPrune(messages: LLMMessage[]): Promise<{ messages: LLMMessage[]; reason: string }> {
    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");
    const recent = nonSystem.slice(-this.preserveRecentCount * 2);
    const older = nonSystem.slice(0, -this.preserveRecentCount * 2);

    // From older messages: keep only assistant text, drop tool results
    const prunedOlder = older.filter((m) => {
      // Keep assistant messages (they contain the agent's reasoning)
      if (m.role === "assistant") return true;
      // Keep user messages (they contain the user's requests)
      if (m.role === "user") return true;
      // Drop tool results from older messages (they're the biggest token consumers)
      return false;
    });

    return {
      messages: [...systemMessages, ...prunedOlder, ...recent],
      reason: `Tier 1: Light prune — removed ${older.length - prunedOlder.length} old tool results`,
    };
  }

  // ── Tier 2: Aggressive Compress ────────────────────────────────────────
  // Summarize older messages via LLM call, keep recent ones verbatim.
  // More expensive but preserves key information.
  private async tierAggressiveCompress(messages: LLMMessage[]): Promise<{ messages: LLMMessage[]; reason: string }> {
    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");

    if (nonSystem.length <= this.preserveRecentCount) {
      return { messages, reason: "Tier 2: Too few messages to compress further" };
    }

    const recent = nonSystem.slice(-this.preserveRecentCount);
    const toCompress = nonSystem.slice(0, -this.preserveRecentCount);

    // Summarize the older messages in chunks
    const summaries: string[] = [];
    const chunkSize = 20;
    for (let i = 0; i < toCompress.length; i += chunkSize) {
      const chunk = toCompress.slice(i, Math.min(i + chunkSize, toCompress.length));
      const summary = await this.summarizeChunk(chunk);
      summaries.push(summary);
    }

    const summaryMessage: LLMMessage = {
      role: "user",
      content: `[Context Summary]\n${summaries.join("\n\n")}`,
    };

    return {
      messages: [...systemMessages, summaryMessage, ...recent],
      reason: `Tier 2: Aggressive compress — summarized ${toCompress.length} messages into ${summaries.length} summaries`,
    };
  }

  // ── Tier 3: Emergency Drop ─────────────────────────────────────────────
  // Keep only the most recent messages, drop everything else.
  // Nuclear option — maximizes space but loses all historical context.
  private async tierEmergencyDrop(messages: LLMMessage[]): Promise<{ messages: LLMMessage[]; reason: string }> {
    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");

    const kept = nonSystem.slice(-this.emergencyKeepCount);
    const dropped = nonSystem.length - kept.length;

    return {
      messages: [...systemMessages, ...kept],
      reason: `Tier 3: Emergency drop — removed ${dropped} messages, keeping only ${kept.length} most recent`,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async summarizeChunk(messages: LLMMessage[]): Promise<string> {
    const text = messages
      .map((m) => `[${m.role}]: ${typeof m.content === "string" ? m.content.slice(0, 500) : "[non-text]"}`)
      .join("\n");

    try {
      const response = await this.provider.generate(
        [
          {
            role: "system",
            content: "Summarize the following conversation excerpt in 2-3 sentences. Preserve key decisions, tool results, and important context. Return ONLY the summary text.",
          },
          { role: "user", content: text.slice(0, 4000) },
        ],
        { temperature: 0.2, maxTokens: 300 }
      );
      return response.content.trim();
    } catch {
      // Fallback: just take the first message's content as a summary
      const first = messages[0];
      return typeof first?.content === "string"
        ? first.content.slice(0, 200) + "..."
        : "[summary unavailable]";
    }
  }
}
