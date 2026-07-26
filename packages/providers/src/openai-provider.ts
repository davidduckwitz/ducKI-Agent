import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionContentPart } from "openai/resources/chat/completions.js";
import type { LLMMessage, LLMResponse, GenerateOptions, LLMContent } from "@ducki/shared";
import type { LLMProvider, ProviderOptions } from "./base.js";
import { ProviderConnectionError, looksLikeConnectionFailure } from "./errors.js";
import { estimateUsage } from "./token-estimate.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/g, "");
  if (!trimmed) return baseUrl;
  return trimmed
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/responses$/i, "");
}

function shouldOmitAuthorizationHeader(apiKey: string): boolean {
  const normalized = apiKey.trim().toLowerCase();
  if (!normalized) return true;
  if (["lm-studio", "not-needed", "none", "null", "undefined"].includes(normalized)) return true;
  return false;
}

function bufferToBase64DataUri(buffer: Buffer, mimeType: string = "image/png"): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function convertLLMContentToOpenAI(content: string | LLMContent[]): string | ChatCompletionContentPart[] {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part): ChatCompletionContentPart => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "image_url") {
      return { type: "image_url", image_url: { url: part.image_url.url, detail: part.image_url.detail } };
    }
    if (part.type === "image_data") {
      return { type: "image_url", image_url: { url: part.image_data.url } };
    }
    return { type: "text", text: "" };
  });
}

function toOpenAIMessages(messages: LLMMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    if (m.role === "tool") {
      return { role: "tool", content: typeof m.content === "string" ? m.content : "tool result", tool_call_id: m.toolCallId ?? "unknown" };
    }
    if (m.role === "assistant") {
      return { role: "assistant", content: typeof m.content === "string" ? m.content : "assistant response" };
    }
    if (m.role === "system") {
      return { role: "system", content: typeof m.content === "string" ? m.content : "system prompt" };
    }
    return { role: "user", content: convertLLMContentToOpenAI(m.content) };
  });
}

export class OpenAIProvider implements LLMProvider {
  readonly name: string = "openai";
  readonly model: string;
  /** Kept so a connection failure can name the endpoint that was actually unreachable. */
  protected readonly endpoint: string;
  private client: OpenAI;
  private defaultOptions: GenerateOptions;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  /** Set once a server has rejected `stream_options`, so the retry without it happens
   *  only on the first stream instead of on every single call. */
  private streamOptionsUnsupported = false;

  constructor(options: ProviderOptions) {
    const rawApiKey = options.apiKey ?? "";
    const normalizedApiKey = rawApiKey.replace(/^Bearer\s+/i, "").trim();
    const omitAuthorizationHeader = shouldOmitAuthorizationHeader(normalizedApiKey);
    const baseURL = normalizeBaseUrl(options.baseUrl);

    this.model = options.model;
    this.endpoint = baseURL;
    this.defaultOptions = options.defaultOptions ?? {};

    const customFetch: typeof fetch = async (input, init) => {
      if (!omitAuthorizationHeader) {
        return fetch(input, init);
      }

      const headers = new Headers(init?.headers ?? {});
      headers.delete("Authorization");
      return fetch(input, { ...(init ?? {}), headers });
    };

    this.client = new OpenAI({
      apiKey: omitAuthorizationHeader ? "sk-no-auth-required" : normalizedApiKey,
      baseURL,
      fetch: customFetch,
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
        // A refused connection is not a rate limit and will not heal by waiting; report
        // it straight away, naming the endpoint, instead of burning the retry budget.
        if (looksLikeConnectionFailure(error)) {
          throw new ProviderConnectionError(this.name, this.endpoint, error);
        }
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
    const openAiMessages = toOpenAIMessages(messages);

    const createStream = (includeUsage: boolean) =>
      this.client.chat.completions.create({
        model: this.model,
        messages: openAiMessages,
        temperature: merged.temperature,
        top_p: merged.topP,
        max_tokens: merged.maxTokens,
        stream: true,
        // Without this the OpenAI streaming protocol never sends a usage chunk at all -
        // which is why every streamed response reported 0 tokens.
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      });

    let stream: Awaited<ReturnType<typeof createStream>>;
    try {
      stream = await this.withRateLimitRetry(() => createStream(!this.streamOptionsUnsupported));
    } catch (error) {
      // Not every OpenAI-compatible server accepts stream_options. Most ignore unknown
      // fields, but one that rejects them must not lose streaming entirely - drop the
      // field once and remember that for this provider instance.
      if (!this.streamOptionsUnsupported && this.rejectsStreamOptions(error)) {
        this.streamOptionsUnsupported = true;
        stream = await this.withRateLimitRetry(() => createStream(false));
      } else {
        throw error;
      }
    }

    let fullContent = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let reportedUsage = false;
    let finalModel = this.model;

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          fullContent += delta;
          onChunk?.(delta);
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
          reportedUsage = promptTokens > 0 || completionTokens > 0;
        }
        finalModel = chunk.model ?? finalModel;
      }
    } catch (error) {
      // The stream can also die mid-flight; classify that the same way as a failure to
      // open it, so callers see one error kind for "endpoint gone" either way.
      if (looksLikeConnectionFailure(error)) {
        throw new ProviderConnectionError(this.name, this.endpoint, error);
      }
      throw error;
    }

    if (!reportedUsage) {
      const estimate = estimateUsage(openAiMessages, fullContent);
      return {
        content: fullContent,
        usage: { ...estimate, estimated: true },
        model: finalModel,
      };
    }

    return {
      content: fullContent,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      model: finalModel,
    };
  }

  /** A server that does not understand stream_options rejects the request outright
   *  (HTTP 400) and names the field. */
  private rejectsStreamOptions(error: unknown): boolean {
    if (this.getStatusCode(error) !== 400) return false;
    const message = error instanceof Error ? error.message : String(error);
    return /stream_options|include_usage/i.test(message);
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
