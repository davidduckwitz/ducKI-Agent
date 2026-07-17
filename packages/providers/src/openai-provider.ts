import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { LLMMessage, LLMResponse, GenerateOptions } from "@ducki/shared";
import type { LLMProvider, ProviderOptions } from "./base.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

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
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;

  constructor(options: ProviderOptions) {
    const rawApiKey = options.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
    const normalizedApiKey = rawApiKey.replace(/^Bearer\s+/i, "").trim();

    this.model = options.model;
    this.defaultOptions = options.defaultOptions ?? {};
    this.client = new OpenAI({
      apiKey: normalizedApiKey,
      baseURL: options.baseUrl,
    });
    this.maxRetries = toPositiveInt(process.env["OPENAI_RATE_LIMIT_RETRIES"], 2);
    this.baseRetryDelayMs = toPositiveInt(process.env["OPENAI_RATE_LIMIT_RETRY_BASE_MS"], 1200);
  }

  private getStatusCode(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return undefined;
    const maybeError = error as { status?: unknown };
    return typeof maybeError.status === "number" ? maybeError.status : undefined;
  }

  private getRetryAfterMs(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return undefined;
    const maybeError = error as { headers?: unknown };
    const headers = maybeError.headers;

    if (!headers) return undefined;
    if (typeof (headers as { get?: unknown }).get === "function") {
      const raw = (headers as { get: (name: string) => string | null }).get("retry-after");
      if (!raw) return undefined;
      const seconds = Number.parseFloat(raw);
      if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
      return undefined;
    }

    if (typeof headers === "object" && headers !== null) {
      const raw = (headers as Record<string, unknown>)["retry-after"];
      if (typeof raw === "string") {
        const seconds = Number.parseFloat(raw);
        if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
      }
    }

    return undefined;
  }

  private isRateLimitError(error: unknown): boolean {
    return this.getStatusCode(error) === 429;
  }

  private createRetryDelayMs(attempt: number, error: unknown): number {
    const retryAfterMs = this.getRetryAfterMs(error);
    if (retryAfterMs && retryAfterMs > 0) return retryAfterMs;
    const expDelay = this.baseRetryDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 250);
    return expDelay + jitter;
  }

  private async withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (!this.isRateLimitError(error) || attempt >= this.maxRetries) {
          break;
        }
        const delayMs = this.createRetryDelayMs(attempt + 1, error);
        await sleep(delayMs);
        attempt++;
      }
    }

    if (this.isRateLimitError(lastError)) {
      throw new Error("429 Provider returned error after retries (rate limited)");
    }
    throw lastError;
  }

  async generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse> {
    const merged = { ...this.defaultOptions, ...options };

    const completion = await this.withRateLimitRetry(() =>
      this.client.chat.completions.create({
        model: this.model,
        messages: toOpenAIMessages(messages),
        temperature: merged.temperature,
        top_p: merged.topP,
        max_tokens: merged.maxTokens,
        stream: false,
      })
    );

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

    const stream = await this.withRateLimitRetry(() =>
      this.client.chat.completions.create({
        model: this.model,
        messages: toOpenAIMessages(messages),
        temperature: merged.temperature,
        top_p: merged.topP,
        max_tokens: merged.maxTokens,
        stream: true,
      })
    );

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
