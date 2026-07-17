import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { LLMMessage, LLMResponse, GenerateOptions } from "@ducki/shared";
import type { LLMProvider, ProviderOptions } from "./base.js";

function toOpenAIMessages(messages: LLMMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "unknown" };
    }
    if (m.role === "assistant") {
      return { role: "assistant", content: m.content };
    }
    if (m.role === "system") {
      return { role: "system", content: m.content };
    }
    return { role: "user", content: m.content };
  });
}

export class OpenAIProvider implements LLMProvider {
  readonly name: string = "openai";
  readonly model: string;
  private client: OpenAI;
  private defaultOptions: GenerateOptions;

  constructor(options: ProviderOptions) {
    const rawApiKey = options.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
    const normalizedApiKey = rawApiKey.replace(/^Bearer\s+/i, "").trim();

    this.model = options.model;
    this.defaultOptions = options.defaultOptions ?? {};
    this.client = new OpenAI({
      apiKey: normalizedApiKey,
      baseURL: options.baseUrl,
    });
  }

  async generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse> {
    const merged = { ...this.defaultOptions, ...options };

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(messages),
      temperature: merged.temperature,
      top_p: merged.topP,
      max_tokens: merged.maxTokens,
      stream: false,
    });

    const choice = completion.choices[0];
    if (!choice) throw new Error("No completion choice returned");

    return {
      content: choice.message.content ?? "",
      usage: {
        promptTokens: completion.usage?.prompt_tokens ?? 0,
        completionTokens: completion.usage?.completion_tokens ?? 0,
        totalTokens: completion.usage?.total_tokens ?? 0,
      },
      model: completion.model,
      finishReason: choice.finish_reason ?? undefined,
    };
  }

  async generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions,
    onChunk?: (chunk: string) => void
  ): Promise<LLMResponse> {
    const merged = { ...this.defaultOptions, ...options };

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(messages),
      temperature: merged.temperature,
      top_p: merged.topP,
      max_tokens: merged.maxTokens,
      stream: true,
    });

    let fullContent = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let finalModel = this.model;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        fullContent += delta;
        onChunk?.(delta);
      }
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0;
        completionTokens = chunk.usage.completion_tokens ?? 0;
      }
      finalModel = chunk.model ?? finalModel;
    }

    return {
      content: fullContent,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      model: finalModel,
    };
  }

  supportsStreaming(): boolean {
    return true;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}
