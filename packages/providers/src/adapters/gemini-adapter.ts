import type { LLMMessage, LLMResponse, GenerateOptions } from "@ducki/shared";
import type { ProviderOptions } from "../base.js";
import { BaseAdapter } from "./base-adapter.js";

/**
 * Google Gemini adapter with support for:
 * - Gemini models (via REST API compatibility)
 * - Basic text generation
 * - Streaming simulation
 */
export class GeminiAdapter extends BaseAdapter {
  readonly name = "gemini";

  constructor(options: ProviderOptions) {
    super(options);
    this.validateConfiguration();
  }

  protected override getMaxOutputTokens(): number {
    // Gemini 2.0 Flash, Pro variants
    if (this.model.includes("2.0")) return 8192;
    if (this.model.includes("pro")) return 8192;
    return 8192;
  }

  protected override getModelFamily(): string {
    return "gemini-2.0";
  }

  /**
   * Convert LLMMessages to API format
   */
  protected override normalizeMessages(messages: LLMMessage[]): unknown {
    return messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [
          {
            text: this.normalizeContent(m.content),
          },
        ],
      }));
  }

  /**
   * Main generate method (stub - requires external SDK)
   */
  override async generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse> {
    const merged = this.mergeOptions(options);
    const systemPrompt = this.extractSystemPrompt(messages);

    // Note: Actual implementation requires @google/generative-ai SDK
    // This is a stub that shows the pattern
    throw new Error(
      `[${this.name}] Gemini adapter requires @google/generative-ai SDK. Install with: npm install @google/generative-ai`
    );
  }

  /**
   * Streaming generate method (stub)
   */
  override async generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions,
    onChunk?: (chunk: string) => void
  ): Promise<LLMResponse> {
    throw new Error(
      `[${this.name}] Gemini adapter requires @google/generative-ai SDK. Install with: npm install @google/generative-ai`
    );
  }

  /**
   * Gemini supports streaming
   */
  override supportsStreaming(): boolean {
    return true;
  }
}
