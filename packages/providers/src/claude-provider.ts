import Anthropic from "@anthropic-ai/sdk";
import type { LLMMessage, LLMResponse, GenerateOptions, LLMContent } from "@ducki/shared";
import type { LLMProvider, ProviderOptions } from "./base.js";

function convertLLMContentToAnthropic(
  content: string | LLMContent[]
): Anthropic.MessageParam["content"] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  const result: Array<{ type: string; [key: string]: unknown }> = [];
  for (const part of content) {
    if (part.type === "text") {
      result.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      result.push({ type: "image", source: { type: "url", url: part.image_url.url } });
    } else if (part.type === "image_data") {
      result.push({ type: "image", source: { type: "url", url: part.image_data.url } });
    }
  }
  return result as unknown as Anthropic.MessageParam["content"];
}

function toAnthropicMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m): Anthropic.MessageParam => {
      const baseContent = convertLLMContentToAnthropic(m.content);

      if (m.role === "assistant") {
        return {
          role: "assistant",
          content: baseContent,
        };
      }

      return {
        role: "user",
        content: baseContent,
      };
    });
}

function extractSystemPrompt(messages: LLMMessage[]): string | undefined {
  const systemMessage = messages.find((m) => m.role === "system");
  if (!systemMessage || typeof systemMessage.content !== "string") {
    return undefined;
  }
  return systemMessage.content;
}

export class ClaudeProvider implements LLMProvider {
  readonly name: string = "claude";
  readonly model: string;
  private client: Anthropic;
  private defaultOptions: GenerateOptions;

  constructor(options: ProviderOptions) {
    this.model = options.model;
    this.defaultOptions = options.defaultOptions ?? {};

    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: "https://api.anthropic.com/v1",
    });
  }

  async generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse> {
    const merged = { ...this.defaultOptions, ...options };
    const systemPrompt = extractSystemPrompt(messages);
    const anthropicMessages = toAnthropicMessages(messages);

    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: merged.maxTokens ?? 4000,
        system: systemPrompt,
        messages: anthropicMessages,
        temperature: merged.temperature,
      },
      { signal: merged.signal }
    );

    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      content,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      model: response.model,
      finishReason: response.stop_reason ?? undefined,
    };
  }

  async generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions,
    onChunk?: (chunk: string) => void
  ): Promise<LLMResponse> {
    const merged = { ...this.defaultOptions, ...options };
    const systemPrompt = extractSystemPrompt(messages);
    const anthropicMessages = toAnthropicMessages(messages);

    const stream = await this.client.messages.stream(
      {
        model: this.model,
        max_tokens: merged.maxTokens ?? 4000,
        system: systemPrompt,
        messages: anthropicMessages,
        temperature: merged.temperature,
      },
      { signal: merged.signal }
    );

    let fullContent = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: string | undefined;

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        fullContent += chunk.delta.text;
        onChunk?.(chunk.delta.text);
      }

      if (chunk.type === "message_start" && chunk.message.usage) {
        promptTokens = chunk.message.usage.input_tokens;
      }

      if (chunk.type === "message_delta" && chunk.usage) {
        completionTokens = chunk.usage.output_tokens;
        finishReason = chunk.delta.stop_reason || undefined;
      }
    }

    return {
      content: fullContent,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      model: this.model,
      finishReason,
    };
  }

  supportsStreaming(): boolean {
    return true;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "test" }],
      });
      return true;
    } catch {
      return false;
    }
  }
}
