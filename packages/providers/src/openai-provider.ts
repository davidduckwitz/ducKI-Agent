import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionContentPart,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions.js";
import type { LLMMessage, LLMResponse, GenerateOptions, LLMContent, ToolDefinition, ToolCall } from "@ducki/shared";
import { INCOMPLETE_STREAM_FINISH_REASON } from "@ducki/shared";
import type { LLMProvider, ProviderOptions } from "./base.js";
import { ProviderConnectionError, looksLikeConnectionFailure, isAbortError } from "./errors.js";
import { estimateUsage } from "./token-estimate.js";
import { getRootLogger } from "@ducki/logger";

const logger = getRootLogger().child("OpenAIProvider");

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
    // Check if the string is JSON (happens when content was serialized to DB and reloaded)
    if (content.trim().startsWith("[") || content.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          // Recursively convert the parsed content
          return convertLLMContentToOpenAI(parsed);
        }
      } catch {
        // Not valid JSON, treat as plain text
        return content;
      }
    }
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

/**
 * Convert our provider-agnostic ToolDefinition[] into OpenAI's `tools` param so the
 * model can emit STRUCTURED tool calls instead of the text `[TOOL:...]` protocol.
 * Native calls put arguments in a dedicated field the server validates, which removes
 * the whole class of "tool-call syntax leaked into a written file" failures that the
 * text protocol suffers with weaker local models.
 */
export function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((t): ChatCompletionTool => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      // OpenAI expects a JSON-Schema object; our ToolDefinition.parameters already is one.
      parameters: (t.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
    },
  }));
}

/** Normalize the OpenAI SDK's tool_calls into our provider-agnostic ToolCall[]. */
export function fromOpenAIToolCalls(
  raw: ChatCompletionMessageToolCall[] | undefined | null
): ToolCall[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const calls: ToolCall[] = [];
  for (const c of raw) {
    // Only function tool calls are supported; skip anything else defensively.
    const fn = (c as { function?: { name?: string; arguments?: string } }).function;
    if (!fn?.name) continue;
    calls.push({
      id: c.id || `call_${calls.length}`,
      type: "function",
      function: { name: fn.name, arguments: fn.arguments ?? "{}" },
    });
  }
  return calls.length > 0 ? calls : undefined;
}

export interface ToOpenAIMessagesOptions {
  /**
   * Render a cacheable system message as content PARTS carrying `cache_control`.
   *
   * Off by default, and deliberately so: the parts form is what OpenRouter needs to place an
   * explicit Anthropic cache breakpoint, but plenty of OpenAI-COMPATIBLE servers (llama.cpp,
   * older LM Studio builds, various local runtimes) only accept a plain string for the system
   * role and either reject the request or silently drop the prompt. Those backends have no
   * prompt cache to address anyway, and OpenAI's own caching is automatic and needs no field -
   * so only the gateway that actually benefits opts in.
   */
  emitCacheControl?: boolean;
}

export function toOpenAIMessages(
  messages: LLMMessage[],
  options: ToOpenAIMessagesOptions = {}
): ChatCompletionMessageParam[] {
  // A role:"tool" message is only valid if a PRECEDING assistant message in the same
  // request echoes a tool_call with the same id. The agent stamps every tool result with
  // an internal id (e.g. "batch_1_0") but stores assistant turns as plain text WITHOUT
  // tool_calls, so those ids have no referent. Emitting role:"tool" for them produces an
  // orphaned message the API drops - the model then never sees the tool output and
  // hallucinates. So only route to role:"tool" when the id is actually echoed; otherwise
  // deliver the result as a normal user message that every backend reliably sees.
  const echoedToolCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const c of m.toolCalls) echoedToolCallIds.add(c.id);
    }
  }

  return messages.map((m): ChatCompletionMessageParam => {
    if (m.role === "tool") {
      const text = typeof m.content === "string" ? m.content : "tool result";
      if (m.toolCallId && echoedToolCallIds.has(m.toolCallId)) {
        return { role: "tool", tool_call_id: m.toolCallId, content: text };
      }
      return { role: "user", content: `[Tool result]\n${text}` };
    }
    if (m.role === "assistant") {
      const content = typeof m.content === "string" ? m.content : "assistant response";
      // Echo native tool_calls back only when the history actually carries them AND their
      // results are present as role:"tool" replies (guarded above). Today the agent doesn't
      // persist assistant tool_calls, so this stays dormant and the text path is used.
      const nativeCalls = m.toolCalls;
      if (nativeCalls && nativeCalls.length > 0) {
        return {
          role: "assistant",
          content: content || null,
          tool_calls: nativeCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.function.name, arguments: c.function.arguments },
          })),
        };
      }
      return { role: "assistant", content };
    }
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : "system prompt";
      if (options.emitCacheControl && m.cacheControl === "ephemeral") {
        return {
          role: "system",
          content: [{ type: "text", text, cache_control: { type: "ephemeral" } }],
        } as unknown as ChatCompletionMessageParam;
      }
      return { role: "system", content: text };
    }

    // For user messages with vision content
    const metadata = typeof m.metadata === "object" ? (m.metadata as Record<string, unknown>) : {};
    const isVisionMessage = metadata?.source === "browser_screenshot";

    // Check for images in LLMContent array (standard format)
    let hasImageUrl = false;
    if (Array.isArray(m.content)) {
      hasImageUrl = (m.content as LLMContent[]).some((part) => part.type === "image_url");
    }

    if (isVisionMessage || hasImageUrl) {
      logger.debug("Vision message detected", {
        source: metadata.source,
        contentType: typeof m.content,
        contentIsArray: Array.isArray(m.content),
        hasImageUrl,
        contentLength: Array.isArray(m.content) ? (m.content as LLMContent[]).length : 0,
      });
    }

    const userMessage: any = { role: "user", content: convertLLMContentToOpenAI(m.content) };

    return userMessage;
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
  /**
   * Whether this backend understands an explicit `cache_control` breakpoint. Only the
   * OpenRouter subclass does - see ToOpenAIMessagesOptions.emitCacheControl for why this is
   * opt-in rather than always-on.
   */
  protected emitsPromptCacheControl(): boolean {
    return false;
  }

  /** Master switch for native tool-calling. Defaults on; set DUCKI_NATIVE_TOOLS=0/false
   *  to force the legacy [TOOL:...] text protocol for every request. */
  private readonly nativeToolsConfigured: boolean;
  /** Flipped when a backend rejects the `tools` param (many local llama.cpp/older
   *  LM Studio builds don't implement it). After that we stop sending `tools` for this
   *  provider instance and the agent's text parser takes over - same self-healing
   *  pattern as streamOptionsUnsupported. Protected (not private) so OllamaProvider's
   *  own raw-fetch request path - which cannot go through this class's `generate()` -
   *  can still participate in the same self-healing fallback. */
  protected nativeToolsUnsupported = false;

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
    const nativeFlag = (process.env["DUCKI_NATIVE_TOOLS"] ?? "").trim().toLowerCase();
    this.nativeToolsConfigured = !["0", "false", "off", "no"].includes(nativeFlag);
  }

  /** Whether native tool-calling should be attempted right now (configured on AND not
   *  yet proven unsupported by this backend). The agent reads this to decide whether to
   *  pass tool definitions and to trust structured tool_calls over its text parser. */
  supportsNativeTools(): boolean {
    return this.nativeToolsConfigured && !this.nativeToolsUnsupported;
  }

  /** A server that doesn't implement function-calling rejects the `tools` param with a
   *  400 that names it (or "function"/"tool"). Detect that so we can disable native
   *  tools for this instance and fall back to the text protocol instead of failing. */
  private rejectsToolsParam(error: unknown): boolean {
    if (this.getStatusCode(error) !== 400) return false;
    const message = error instanceof Error ? error.message : String(error);
    if (/\btools?\b|function[_ -]?call|tool[_ -]?choice|unsupported|not supported/i.test(message)) {
      return true;
    }
    // Some local backends crash inside the MODEL'S OWN built-in Jinja chat template while
    // rendering the `tools` param - e.g. LM Studio's bundled gpt-oss template throws
    // "Function is not a bool value" for any tool with an array parameter (param_spec['items']
    // mis-evaluates in their minja engine). That's a template bug unrelated to our schema, but
    // it only ever fires because we sent `tools`, so treat it exactly like "backend can't do
    // native tools" and fall back to the text protocol instead of failing the whole run.
    return /jinja|chat template|predict request returned 500/i.test(message);
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
    logger.debug("generate() called", { providerName: this.name, type: this.constructor.name });
    const merged = { ...this.defaultOptions, ...options };
    const useNativeTools = this.supportsNativeTools() && (merged.tools?.length ?? 0) > 0;

    const buildRequest = (withTools: boolean) => ({
      model: this.model,
      messages: toOpenAIMessages(messages, { emitCacheControl: this.emitsPromptCacheControl() }),
      temperature: merged.temperature,
      top_p: merged.topP,
      max_tokens: merged.maxTokens,
      ...(merged.frequencyPenalty !== undefined ? { frequency_penalty: merged.frequencyPenalty } : {}),
      ...(merged.presencePenalty !== undefined ? { presence_penalty: merged.presencePenalty } : {}),
      stream: false as const,
      ...(withTools && merged.tools ? { tools: toOpenAITools(merged.tools), tool_choice: "auto" as const } : {}),
    });

    let completion;
    try {
      completion = await this.withRateLimitRetry(() =>
        this.client.chat.completions.create(buildRequest(useNativeTools), { signal: merged.signal })
      );
    } catch (error) {
      // An intentional cancellation (Stop button, run timeout) must propagate immediately -
      // retrying or falling back to a differently-shaped request would just delay it.
      if (isAbortError(error)) throw error;
      // Backend doesn't implement the `tools` param: disable native tools for this
      // instance and retry once WITHOUT them so the run continues on the text protocol.
      if (useNativeTools && !this.nativeToolsUnsupported && this.rejectsToolsParam(error)) {
        this.nativeToolsUnsupported = true;
        completion = await this.withRateLimitRetry(() =>
          this.client.chat.completions.create(buildRequest(false), { signal: merged.signal })
        );
      } else {
        throw error;
      }
    }

    const choice = completion.choices[0];
    if (!choice) throw new Error("No completion choice returned");

    // Same "count when the server reports it, estimate only when it doesn't" contract as
    // generateStream() below - this used to silently report 0/0/0 with no `estimated` flag
    // whenever a server (several local OpenAI-compat backends among them) omitted `usage` on
    // a non-streaming response, which looked like a confirmed zero-token reply instead of an
    // unknown one.
    const reportedUsage = (completion.usage?.prompt_tokens ?? 0) > 0 || (completion.usage?.completion_tokens ?? 0) > 0;
    const usage = reportedUsage
      ? {
          promptTokens: completion.usage?.prompt_tokens ?? 0,
          completionTokens: completion.usage?.completion_tokens ?? 0,
          totalTokens: completion.usage?.total_tokens ?? 0,
          // Reported by OpenAI and by OpenRouter for cache-capable models. Included in
          // prompt_tokens already, so this is a breakdown, not an addition.
          cachedInputTokens:
            (completion.usage as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)
              ?.prompt_tokens_details?.cached_tokens ?? 0,
          estimated: false,
        }
      : { ...estimateUsage(buildRequest(useNativeTools).messages, choice.message.content ?? ""), estimated: true };

    return {
      content: choice.message.content ?? "",
      toolCalls: fromOpenAIToolCalls(choice.message.tool_calls),
      usage,
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
    const openAiMessages = toOpenAIMessages(messages, { emitCacheControl: this.emitsPromptCacheControl() });
    const useNativeTools = this.supportsNativeTools() && (merged.tools?.length ?? 0) > 0;

    // `withTools` is an explicit param (not just closing over `useNativeTools`) so the
    // tools-rejected retry below can actually drop `tools` from the request - closing over
    // the outer const would keep resending it since setting nativeToolsUnsupported=true
    // doesn't change an already-captured value, causing the same backend crash to repeat.
    const createStream = (includeUsage: boolean, withTools: boolean) =>
      this.client.chat.completions.create(
        {
          model: this.model,
          messages: openAiMessages,
          temperature: merged.temperature,
          top_p: merged.topP,
          max_tokens: merged.maxTokens,
          ...(merged.frequencyPenalty !== undefined ? { frequency_penalty: merged.frequencyPenalty } : {}),
          ...(merged.presencePenalty !== undefined ? { presence_penalty: merged.presencePenalty } : {}),
          stream: true,
          // Without this the OpenAI streaming protocol never sends a usage chunk at all -
          // which is why every streamed response reported 0 tokens.
          ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
          ...(withTools && merged.tools ? { tools: toOpenAITools(merged.tools), tool_choice: "auto" as const } : {}),
        },
        { signal: merged.signal }
      );

    let stream: Awaited<ReturnType<typeof createStream>>;
    try {
      stream = await this.withRateLimitRetry(() => createStream(!this.streamOptionsUnsupported, useNativeTools));
    } catch (error) {
      // An intentional cancellation must propagate immediately, not trigger a feature-probing
      // retry (stream_options / tools) that would just delay the stop the user asked for.
      if (isAbortError(error)) throw error;
      // Not every OpenAI-compatible server accepts stream_options. Most ignore unknown
      // fields, but one that rejects them must not lose streaming entirely - drop the
      // field once and remember that for this provider instance.
      if (!this.streamOptionsUnsupported && this.rejectsStreamOptions(error)) {
        this.streamOptionsUnsupported = true;
        stream = await this.withRateLimitRetry(() => createStream(false, useNativeTools));
      } else if (useNativeTools && !this.nativeToolsUnsupported && this.rejectsToolsParam(error)) {
        // Backend can stream but not with `tools`: disable native tools and reopen the
        // stream without them so the run falls back to the text protocol.
        this.nativeToolsUnsupported = true;
        stream = await this.withRateLimitRetry(() => createStream(!this.streamOptionsUnsupported, false));
      } else {
        throw error;
      }
    }

    let fullContent = "";
    let promptTokens = 0;
    let cachedInputTokens = 0;
    let completionTokens = 0;
    let reportedUsage = false;
    let finalModel = this.model;
    let finalFinishReason: string | undefined;
    // Tool-call deltas arrive fragmented across chunks, keyed by `index`; accumulate the
    // id/name/arguments pieces per slot and assemble them once the stream ends.
    const toolCallAccum: Array<{ id: string; name: string; arguments: string }> = [];

    try {
      for await (const chunk of stream) {
        const choice0 = chunk.choices[0];
        const delta = choice0?.delta?.content ?? "";
        if (delta) {
          fullContent += delta;
          onChunk?.(delta);
        }
        const toolDeltas = choice0?.delta?.tool_calls;
        if (toolDeltas) {
          for (const td of toolDeltas) {
            const idx = td.index ?? 0;
            const slot = (toolCallAccum[idx] ??= { id: "", name: "", arguments: "" });
            if (td.id) slot.id = td.id;
            if (td.function?.name) slot.name = td.function.name;
            if (td.function?.arguments) slot.arguments += td.function.arguments;
          }
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
          cachedInputTokens =
            (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } })
              .prompt_tokens_details?.cached_tokens ?? 0;
          reportedUsage = promptTokens > 0 || completionTokens > 0;
        }
        finalModel = chunk.model ?? finalModel;
        finalFinishReason = choice0?.finish_reason ?? finalFinishReason;
      }
    } catch (error) {
      // An abort is the user pressing Stop - never salvage, never reclassify.
      if (isAbortError(error)) throw error;

      // A stream that dies AFTER delivering content is a different situation from one that
      // never opened. Throwing here discarded everything received - for a large file that is
      // most of the document - and sent the caller into a full synchronous re-run, which is
      // the very mode that struggles with a big max_tokens.
      //
      // So the partial response is handed back, flagged as incomplete. Callers treat that
      // exactly like hitting the output cap: usable for reading and reasoning, refused for
      // anything that would persist a half-written payload. Nothing is silently completed.
      if (fullContent.length > 0 || toolCallAccum.length > 0) {
        logger.warn("Stream ended prematurely; returning the partial response as incomplete", {
          provider: this.name,
          receivedChars: fullContent.length,
          error: error instanceof Error ? error.message : String(error),
        });
        finalFinishReason = INCOMPLETE_STREAM_FINISH_REASON;
      } else {
        // Nothing arrived at all - classify as a failure to reach the endpoint, as before.
        if (looksLikeConnectionFailure(error)) {
          throw new ProviderConnectionError(this.name, this.endpoint, error);
        }
        throw error;
      }
    }

    const toolCalls: ToolCall[] | undefined = toolCallAccum.length > 0
      ? toolCallAccum
          .filter((c) => c.name)
          .map((c, i) => ({
            id: c.id || `call_${i}`,
            type: "function" as const,
            function: { name: c.name, arguments: c.arguments || "{}" },
          }))
      : undefined;
    const normalizedToolCalls = toolCalls && toolCalls.length > 0 ? toolCalls : undefined;

    if (!reportedUsage) {
      const estimate = estimateUsage(openAiMessages, fullContent);
      return {
        content: fullContent,
        toolCalls: normalizedToolCalls,
        usage: { ...estimate, estimated: true },
        model: finalModel,
        finishReason: finalFinishReason,
      };
    }

    return {
      content: fullContent,
      toolCalls: normalizedToolCalls,
      finishReason: finalFinishReason,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cachedInputTokens },
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

  async listModels(): Promise<Array<{ id: string; name: string; contextLength?: number }>> {
    const page = await this.client.models.list();
    return page.data.flatMap((model) => {
      const id = model.id?.trim();
      if (!id) return [];
      // Not part of the OpenAI API/SDK type - LM Studio's /v1/models response adds this as an
      // extra field per entry (seen as `max_context_length` and, on older builds, `loaded_context_length`).
      // Read defensively; every other OpenAI-compatible server just omits it.
      const raw = model as unknown as { max_context_length?: unknown; loaded_context_length?: unknown };
      const contextLength = [raw.max_context_length, raw.loaded_context_length]
        .map((v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined))
        .find((v) => v !== undefined);
      return [{ id, name: id, ...(contextLength ? { contextLength } : {}) }];
    });
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
