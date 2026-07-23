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

/**
 * Compresses conversation history by summarizing message ranges.
 * Enables long-running conversations without LLM context overflow.
 */
export class ConversationCompressor {
  private logger: Logger;
  private summaryCache = new Map<string, ConversationSummary>();
  private readonly compressionThreshold = 50; // Summarize after 50 messages

  constructor(private readonly provider: LLMProvider) {
    this.logger = getRootLogger().child("ConversationCompressor");
  }

  /**
   * Check if a message range should be compressed.
   */
  shouldCompress(totalMessages: number): boolean {
    return totalMessages > this.compressionThreshold;
  }

  /**
   * Summarize a range of messages into a brief summary.
   */
  async summarizeRange(messages: LLMMessage[], startIndex: number, endIndex: number): Promise<ConversationSummary> {
    const cacheKey = `${startIndex}_${endIndex}`;
    const cached = this.summaryCache.get(cacheKey);
    if (cached) return cached;

    const rangMessages = messages.slice(startIndex, endIndex + 1);
    const conversationText = rangMessages
      .map((m) => `[${m.role}]: ${typeof m.content === "string" ? m.content : ""}`)
      .join("\n\n");

    try {
      const summaryResponse = await this.provider.generate([
        {
          role: "system",
          content:
            "Compress the following conversation into 2-3 sentences. Preserve key decisions, accomplishments, and context.",
        },
        { role: "user", content: conversationText },
      ]);

      const decisionsResponse = await this.provider.generate([
        {
          role: "system",
          content:
            "Extract 3-5 key decisions or important points from this conversation. Return as JSON array of strings.",
        },
        { role: "user", content: conversationText },
      ]);

      let keyDecisions: string[] = [];
      try {
        const parsed = JSON.parse(decisionsResponse.content);
        keyDecisions = Array.isArray(parsed) ? parsed.slice(0, 5) : [];
      } catch {
        keyDecisions = [];
      }

      const summary: ConversationSummary = {
        messageRangeStart: startIndex,
        messageRangeEnd: endIndex,
        summary: summaryResponse.content.trim(),
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
