import type { LLMProvider } from "@ducki/providers";
import type { LLMMessage } from "@ducki/shared";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";

export interface ConversationSummary {
  messageRangeStart: number;
  messageRangeEnd: number;
  summary: string;
  keyDecisions: string[];
  createdAt: string;
}

/** ~3.6 chars/token - same constant packages/providers/token-estimate.ts uses, kept in sync
 *  by hand since duplicating one constant is simpler than a shared dependency for it. */
const CHARS_PER_TOKEN = 3.6;
/**
 * Trigger point in ESTIMATED tokens, not raw message count. Message count was a poor proxy for
 * context pressure - 50 short tool-result messages triggered compression well before they
 * threatened the context window, while a handful of huge file-content messages could blow past
 * it without ever compressing. ~11k tokens is a reasonable "the older half of this conversation
 * is worth summarizing" point for typical local-model context windows (8k-32k) without firing
 * on every short run.
 */
const COMPRESSION_THRESHOLD_TOKENS = 11_000;

/**
 * Compresses conversation history by summarizing message ranges.
 * Enables long-running conversations without LLM context overflow.
 */
export class ConversationCompressor {
  private logger: Logger;
  private summaryCache = new Map<string, ConversationSummary>();
  private readonly compressionThresholdChars = COMPRESSION_THRESHOLD_TOKENS * CHARS_PER_TOKEN;

  constructor(private readonly provider: LLMProvider) {
    this.logger = getRootLogger().child("ConversationCompressor");
  }

  private messageChars(message: LLMMessage): number {
    return typeof message.content === "string" ? message.content.length : 0;
  }

  /** Cheap (no LLM call) - a running char count the caller already has to build the prompt
   *  anyway, so this costs nothing extra to check on every iteration. */
  shouldCompress(messages: LLMMessage[]): boolean {
    let chars = 0;
    for (const m of messages) {
      chars += this.messageChars(m);
      if (chars > this.compressionThresholdChars) return true;
    }
    return false;
  }

  /**
   * Truncate message content to prevent context overflow during compression.
   */
  private truncateMessage(content: string, maxChars: number = 500): string {
    if (content.length <= maxChars) return content;
    return content.substring(0, maxChars) + "...[truncated]";
  }

  /**
   * Summarize a range of messages into a brief summary.
   *
   * One LLM call, not two: this used to fire a separate "extract key decisions" request after
   * the "write 2-3 sentences" request, on the same conversationText, for every chunk - doubling
   * the cost and latency of every compression for no benefit a single structured-JSON request
   * doesn't already give.
   */
  async summarizeRange(messages: LLMMessage[], startIndex: number, endIndex: number): Promise<ConversationSummary> {
    const cacheKey = `${startIndex}_${endIndex}`;
    const cached = this.summaryCache.get(cacheKey);
    if (cached) return cached;

    const rangMessages = messages.slice(startIndex, endIndex + 1);
    const conversationText = rangMessages
      .map((m) => `[${m.role}]: ${this.truncateMessage(typeof m.content === "string" ? m.content : "")}`)
      .join("\n\n");

    try {
      const response = await this.provider.generate([
        {
          role: "system",
          content:
            "Summarize the following conversation excerpt. Respond with ONLY a JSON object of the shape " +
            '{"summary": string, "keyDecisions": string[]} - no prose before or after it. ' +
            '"summary" is 2-3 sentences preserving key decisions, accomplishments, and context. ' +
            '"keyDecisions" is 3-5 short bullet-point strings for the most important decisions or outcomes.',
        },
        { role: "user", content: conversationText },
      ], { maxTokens: 600 });

      let parsedSummary = "";
      let keyDecisions: string[] = [];
      try {
        // Models occasionally wrap JSON in a code fence or add a leading/trailing sentence
        // despite the instruction - pull out the first {...} block rather than requiring an
        // exact-match parse, which failed silently on every minor deviation.
        const match = /\{[\s\S]*\}/.exec(response.content);
        const parsed = JSON.parse(match ? match[0] : response.content) as { summary?: unknown; keyDecisions?: unknown };
        parsedSummary = typeof parsed.summary === "string" ? parsed.summary : "";
        keyDecisions = Array.isArray(parsed.keyDecisions) ? parsed.keyDecisions.filter((d): d is string => typeof d === "string").slice(0, 5) : [];
      } catch {
        // Fallback: the model answered in prose instead of JSON - still usable as the summary,
        // just without a separate key-decisions breakdown.
        parsedSummary = response.content.trim();
      }

      const summary: ConversationSummary = {
        messageRangeStart: startIndex,
        messageRangeEnd: endIndex,
        summary: parsedSummary || response.content.trim(),
        keyDecisions,
        createdAt: new Date().toISOString(),
      };

      this.summaryCache.set(cacheKey, summary);
      this.logger.debug("Conversation range summarized", {
        start: startIndex,
        end: endIndex,
        summaryLength: summary.summary.length,
      });

      return summary;
    } catch (error) {
      this.logger.warn("Failed to summarize conversation range", {
        error: error instanceof Error ? error.message : String(error),
        start: startIndex,
        end: endIndex,
      });

      // Return a simple summary on error
      return {
        messageRangeStart: startIndex,
        messageRangeEnd: endIndex,
        summary: `Messages ${startIndex} to ${endIndex} [compression failed]`,
        keyDecisions: [],
        createdAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Build compressed conversation context: keep last N messages, summarize older ones.
   */
  async buildCompressedContext(
    messages: LLMMessage[],
    keepRecentCount: number = 20
  ): Promise<{ recentMessages: LLMMessage[]; summaries: ConversationSummary[] }> {
    if (messages.length <= keepRecentCount) {
      return { recentMessages: messages, summaries: [] };
    }

    const summaries: ConversationSummary[] = [];
    const recentMessages = messages.slice(-keepRecentCount);
    const toCompress = messages.slice(0, -keepRecentCount);

    // Summarize in chunks of ~50 messages
    for (let i = 0; i < toCompress.length; i += 50) {
      const end = Math.min(i + 50, toCompress.length);
      const summary = await this.summarizeRange(messages, i, i + end - 1);
      summaries.push(summary);
    }

    return { recentMessages, summaries };
  }

  /**
   * Get all cached summaries.
   */
  getCachedSummaries(): ConversationSummary[] {
    return Array.from(this.summaryCache.values());
  }

  /**
   * Clear cache for a specific range or all.
   */
  clearCache(startIndex?: number, endIndex?: number): void {
    if (startIndex !== undefined && endIndex !== undefined) {
      const cacheKey = `${startIndex}_${endIndex}`;
      this.summaryCache.delete(cacheKey);
    } else {
      this.summaryCache.clear();
    }
  }
}
