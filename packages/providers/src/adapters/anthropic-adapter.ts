import Anthropic from "@anthropic-ai/sdk";
import type { LLMMessage, LLMResponse, GenerateOptions } from "@ducki/shared";
import type { ProviderOptions } from "../base.js";
import { BaseAdapter } from "./base-adapter.js";
import { getRootLogger } from "@ducki/logger";

const logger = getRootLogger().child("AnthropicAdapter");

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

    logger.debug("Initializing", {
      hasApiKey: !!this.apiKey,
      apiKeyStart: this.apiKey?.substring(0, 20),
      model: this.model,
      baseUrl: this.baseUrl,
    });

    this.client = new Anthropic({
      apiKey: this.apiKey,
    });
  }

  /**
   * Output-token ceiling per model family. This CLAMPS whatever the caller asked for, so a value
   * that is too low silently truncates long output - and the previous numbers (4096 for
   * opus/sonnet, 1024 for haiku) were written for the Claude 3.5 generation and had not moved
   * since. They cut a current model to a fraction of its real capability, which is exactly how a
   * file write arrives half-finished.
   *
   * Raised only for the generations whose 128K output limit is documented (Fable/Mythos 5,
   * Opus 5 / 4.8 / 4.7 / 4.6, Sonnet 5 / 4.6). Anything not positively identified keeps the old
   * conservative ceiling rather than being given a number nobody verified.
   */
  protected override getMaxOutputTokens(): number {
    const model = this.model.toLowerCase();

    // 128K-output generation. Matched on the version marker so a 3.x model never falls in here.
    const modernGeneration = /(fable|mythos)-5|opus-(5|4-[678])|sonnet-(5|4-6)/.test(model);
    if (modernGeneration) return 128000;

    if (model.includes("opus") || model.includes("sonnet")) return 4096;
    if (model.includes("haiku")) return 1024;
    return 4096;
  }

  protected override getModelFamily(): string {
    return "claude-3.5";
  }

  /**
   * Convert LLMMessages to Anthropic MessageParam format.
   *
   * The Messages API requires the conversation to start on a user turn and to alternate roles.
   * Our history satisfies neither by construction - tool results are separate messages that all
   * collapse onto `user`, and a context-window cut can begin on an assistant turn - so adjacent
   * same-role messages are merged (their content blocks simply concatenate, which is how the API
   * models a multi-part turn) and a leading assistant turn is dropped instead of being rejected.
   */
  protected override normalizeMessages(messages: LLMMessage[]): unknown[] {
    const mapped = messages
      .filter((m) => m.role !== "system") // System is handled separately
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: this.normalizeContent(m.content),
      }));

    while (mapped.length > 0 && mapped[0]!.role === "assistant") {
      mapped.shift();
    }

    const merged: Array<{ role: string; content: unknown }> = [];
    for (const message of mapped) {
      const previous = merged[merged.length - 1];
      if (previous && previous.role === message.role) {
        previous.content = [
          ...(Array.isArray(previous.content) ? previous.content : [previous.content]),
          ...(Array.isArray(message.content) ? message.content : [message.content]),
        ];
        continue;
      }
      merged.push({ role: message.role, content: message.content });
    }

    return merged;
  }

  /**
   * Builds `system` as an array of blocks so a prompt-cache breakpoint can be attached to it.
   *
   * Anthropic caches everything up to and including the block carrying `cache_control`. The
   * agent's static system prompt (directive, tool protocol, tool definitions, skills) is the
   * single largest constant in a multi-iteration run; without a breakpoint every iteration
   * re-sends and re-pays for all of it. The pinned SDK's types predate caching, so the field is
   * added on a plain object - the request body is serialised as JSON either way.
   */
  private buildSystemBlocks(messages: LLMMessage[]): unknown {
    const systemMessages = messages.filter((m) => m.role === "system" && typeof m.content === "string");
    if (systemMessages.length === 0) return undefined;

    return systemMessages.map((m) => {
      const block: Record<string, unknown> = { type: "text", text: m.content as string };
      if (m.cacheControl === "ephemeral") block["cache_control"] = { type: "ephemeral" };
      return block;
    });
  }

  /**
   * Main generate method
   */
  override async generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse> {
    const merged = this.mergeOptions(options);
    const systemBlocks = this.buildSystemBlocks(messages);
    const anthropicMessages = this.normalizeMessages(messages);

    try {
      const response = await (this.client.messages.create as unknown as (params: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
        model: string;
        stop_reason: string;
        usage: {
          input_tokens: number;
          output_tokens: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      }>)({
        model: this.model,
        max_tokens: merged.maxTokens ?? 1024,
        ...(systemBlocks ? { system: systemBlocks } : {}),
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

      // Anthropic reports cache reads/writes SEPARATELY from input_tokens, so an honest total
      // has to add them back in - otherwise a well-cached run looks like it consumed no input.
      const cachedInputTokens = response.usage.cache_read_input_tokens ?? 0;
      const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? 0;
      const promptTokens = response.usage.input_tokens + cachedInputTokens + cacheWriteTokens;

      return {
        content,
        model: response.model,
        finishReason: response.stop_reason,
        usage: {
          promptTokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: promptTokens + response.usage.output_tokens,
          cachedInputTokens,
          cacheWriteTokens,
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

  override async listModels(): Promise<Array<{ id: string; name: string }>> {
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { "x-api-key": this.apiKey ?? "", "anthropic-version": "2023-06-01" },
    });
    if (!response.ok) throw new Error(`Anthropic models API error: ${response.status} ${response.statusText}`);
    const body = await response.json() as { data?: Array<{ id?: string; display_name?: string }> };
    return (body.data ?? []).flatMap((model) => {
      const id = model.id?.trim();
      return id ? [{ id, name: model.display_name?.trim() || id }] : [];
    });
  }
}
