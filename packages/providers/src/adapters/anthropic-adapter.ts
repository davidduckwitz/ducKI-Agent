import Anthropic from "@anthropic-ai/sdk";
import type { LLMMessage, LLMResponse, GenerateOptions } from "@ducki/shared";
import type { ProviderOptions } from "../base.js";
import { BaseAdapter } from "./base-adapter.js";

/**
 * Anthropic Claude adapter with support for:
 * - Multiple Claude models
 * - Streaming responses
 * - System prompts
 */
export class AnthropicAdapter extends BaseAdapter {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(options: ProviderOptions) {
    super(options);
    this.validateConfiguration();

    this.client = new Anthropic({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
    });
  }

  protected override getMaxOutputTokens(): number {
    // Claude 3.5 Sonnet, Opus, Haiku variants
    if (this.model.includes("opus")) return 4096;
    if (this.model.includes("sonnet")) return 4096;
    if (this.model.includes("haiku")) return 1024;
    return 4096; // Default
  }

  protected override getModelFamily(): string {
    return "claude-3.5";
  }

  /**
   * Convert LLMMessages to Anthropic MessageParam format
   */
  protected override normalizeMessages(messages: LLMMessage[]): unknown[] {
    return messages
      .filter((m) => m.role !== "system") // System is handled separately
      .map((m) => {
        const content = this.normalizeContent(m.content);

        if (m.role === "assistant") {
          return {
            role: "assistant",
            content,
          };
        }

        return {
          role: "user",
          content,
        };
      });
  }

  /**
   * Main generate method
   */
  override async generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse> {
    const merged = this.mergeOptions(options);
    const systemPrompt = this.extractSystemPrompt(messages);
    const anthropicMessages = this.normalizeMessages(messages);

    try {
      const response = await (this.client.messages.create as unknown as (params: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
        model: string;
        stop_reason: string;
        usage: { input_tokens: number; output_tokens: number };
      }>)({
        model: this.model,
        max_tokens: merged.maxTokens ?? 1024,
        system: systemPrompt,
        messages: anthropicMessages,
        temperature: merged.temperature ?? 1,
        top_p: merged.topP,
      });

      // Extract text content
      let content = "";
      for (const block of response.content) {
        if (block.type === "text") {
          content += block.text;
        }
      }

      return {
        content,
        model: response.model,
        finishReason: response.stop_reason,
        usage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        },
      };
    } catch (error) {
      const classified = this.classifyError(error);
      throw new Error(`[${this.name}] ${classified.category}: ${classified.message}`);
    }
  }

  /**
   * Streaming generate method (simplified)
   */
  override async generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions,
    onChunk?: (chunk: string) => void
  ): Promise<LLMResponse> {
    // For now, fall back to non-streaming generate and simulate chunks
    const result = await this.generate(messages, options);

    // Emit chunks from the result
    if (onChunk) {
      const chunkSize = 50;
      for (let i = 0; i < result.content.length; i += chunkSize) {
        onChunk(result.content.slice(i, i + chunkSize));
      }
    }

    return result;
  }

  /**
   * Anthropic supports streaming (via simulate)
   */
  override supportsStreaming(): boolean {
    return true;
  }
}
