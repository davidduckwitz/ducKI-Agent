import { claudeReasoningOptions } from "./reasoning.js";
import Anthropic from "@anthropic-ai/sdk";
import type { LLMMessage, LLMResponse, GenerateOptions, LLMContent, ToolDefinition, ToolCall } from "@ducki/shared";
import type { LLMProvider, ProviderOptions } from "./base.js";

/**
 * The pinned @anthropic-ai/sdk (0.28.0) predates prompt caching, so its types know nothing about
 * `cache_control` or the cache token counters - even though the HTTP API accepts and returns them
 * (caching is generally available and needs no beta header). The SDK serialises request bodies as
 * plain JSON and hands responses back as parsed JSON, so both directions work at runtime; only the
 * compile-time types are missing. These aliases add exactly the missing fields and nothing else,
 * so upgrading the SDK later removes them without touching any logic.
 */
type CacheControl = { cache_control?: { type: "ephemeral" } };
type CacheableTextBlock = Anthropic.TextBlockParam & CacheControl;
type CacheableTool = Anthropic.Tool & CacheControl;
type CachingUsage = { cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type ContentBlockParamLike = { type: string; [key: string]: unknown };

/** data: URLs must be sent as a base64 source - the `url` source only accepts http(s). */
function toImageBlock(url: string): ContentBlockParamLike {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match) {
    return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  }
  return { type: "image", source: { type: "url", url } };
}

/** Always returns block objects; empty text blocks are dropped because the API rejects them. */
function convertLLMContentToAnthropic(content: string | LLMContent[]): ContentBlockParamLike[] {
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", text: content }] : [];
  }
  const result: ContentBlockParamLike[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text?.trim()) result.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      result.push(toImageBlock(part.image_url.url));
    } else if (part.type === "image_data") {
      result.push(toImageBlock(part.image_data.url));
    }
  }
  return result;
}

function contentAsText(content: string | LLMContent[]): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/**
 * The Messages API requires the conversation to start with a user turn and to alternate
 * roles. Our history does neither by construction: tool results are carried as their own
 * messages and all collapse onto `user`, and a context window cut can start on an assistant
 * turn. So adjacent same-role messages are merged into one (their content blocks simply
 * concatenate, which is exactly how the API models a multi-part turn) and a leading
 * assistant turn is dropped rather than sent to be rejected.
 *
 * Tool results: same rule as toOpenAIMessages - a native tool_result is only valid when the
 * preceding assistant turn carries the matching tool_use. The agent currently stores assistant
 * turns as plain text, so most results go out as a "[Tool result]" user text block instead of
 * an orphaned tool_result the API would reject.
 *
 * The last block of the final message gets a cache breakpoint, so the growing history is cached
 * incrementally: each iteration reads the previous iteration's prefix at the cached rate instead
 * of re-paying the whole conversation.
 */
export function toAnthropicMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
  const echoedToolUseIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const call of m.toolCalls) echoedToolUseIds.add(call.id);
    }
  }

  const mapped: Array<{ role: "user" | "assistant"; content: ContentBlockParamLike[] }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "tool") {
      const text = contentAsText(m.content);
      if (m.toolCallId && echoedToolUseIds.has(m.toolCallId)) {
        mapped.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: text || "(empty result)" }],
        });
      } else {
        mapped.push({ role: "user", content: [{ type: "text", text: `[Tool result]\n${text || "(empty result)"}` }] });
      }
      continue;
    }

    if (m.role === "assistant") {
      const content = convertLLMContentToAnthropic(m.content);
      for (const call of m.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          input = { raw: call.function.arguments };
        }
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
      }
      mapped.push({ role: "assistant", content });
      continue;
    }

    mapped.push({ role: "user", content: convertLLMContentToAnthropic(m.content) });
  }

  while (mapped.length > 0 && mapped[0]!.role === "assistant") {
    mapped.shift();
  }

  const merged: Array<{ role: "user" | "assistant"; content: ContentBlockParamLike[] }> = [];
  for (const message of mapped) {
    if (message.content.length === 0) continue;
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      // tool_result blocks must come first in a user turn.
      previous.content = [...previous.content, ...message.content].sort(
        (a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result")
      );
      continue;
    }
    merged.push({ role: message.role, content: [...message.content] });
  }

  enforceToolPairing(merged);

  const lastMessage = merged[merged.length - 1];
  const lastBlock = lastMessage?.content[lastMessage.content.length - 1];
  if (lastBlock) lastBlock["cache_control"] = { type: "ephemeral" };

  return merged as unknown as Anthropic.MessageParam[];
}

/**
 * The API only accepts a tool_use whose tool_result sits in the IMMEDIATELY following user turn,
 * and a tool_result only right after its tool_use. The history does not guarantee that (a user
 * message or compression can land in between, a result can be pruned), so any block that is not
 * correctly paired is degraded to plain text instead of failing the whole request with a 400.
 */
function enforceToolPairing(messages: Array<{ role: "user" | "assistant"; content: ContentBlockParamLike[] }>): void {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const previous = messages[i - 1];
    const next = messages[i + 1];

    if (message.role === "assistant") {
      const answered = new Set(
        next?.role === "user"
          ? next.content.filter((b) => b.type === "tool_result").map((b) => b["tool_use_id"] as string)
          : []
      );
      message.content = message.content.map((block) =>
        block.type === "tool_use" && !answered.has(block["id"] as string)
          ? { type: "text", text: `[Tool call] ${String(block["name"])} ${JSON.stringify(block["input"] ?? {})}` }
          : block
      );
      continue;
    }

    const requested = new Set(
      previous?.role === "assistant"
        ? previous.content.filter((b) => b.type === "tool_use").map((b) => b["id"] as string)
        : []
    );
    message.content = message.content
      .map((block) =>
        block.type === "tool_result" && !requested.has(block["tool_use_id"] as string)
          ? { type: "text", text: `[Tool result]\n${String(block["content"] ?? "")}` }
          : block
      )
      .sort((a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result"));
  }
}

/**
 * Builds the `system` field as an array of blocks rather than a single string, so a cache
 * breakpoint can be attached to it.
 *
 * Anthropic caches everything from the start of the request up to and including the block
 * carrying `cache_control`. The static part of an agent's system prompt (directive, tool-call
 * protocol, tool definitions) is by far the largest constant in a multi-iteration run - without
 * a breakpoint it is re-billed at full price on every single iteration.
 */
function buildSystemBlocks(messages: LLMMessage[]): CacheableTextBlock[] | undefined {
  const systemMessages = messages.filter((m) => m.role === "system" && typeof m.content === "string");
  if (systemMessages.length === 0) return undefined;

  return systemMessages.map((m) => {
    const block: CacheableTextBlock = { type: "text", text: m.content as string };
    if (m.cacheControl === "ephemeral") {
      block.cache_control = { type: "ephemeral" };
    }
    return block;
  });
}

function toAnthropicTools(tools: ToolDefinition[]): CacheableTool[] {
  return tools.map((tool, index): CacheableTool => {
    const converted: CacheableTool = {
      name: tool.name,
      description: tool.description,
      input_schema: (tool.parameters ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
    };
    // Tool definitions sit at the very front of the cacheable prefix and never change within a
    // run, so the breakpoint goes on the LAST one - that caches the whole tool block in one go.
    if (index === tools.length - 1) {
      converted.cache_control = { type: "ephemeral" };
    }
    return converted;
  });
}

function fromAnthropicToolUse(blocks: Anthropic.ContentBlock[]): ToolCall[] | undefined {
  const calls = blocks
    .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
    .map((block): ToolCall => ({
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
    }));
  return calls.length > 0 ? calls : undefined;
}

export class ClaudeProvider implements LLMProvider {
  readonly name: string = "claude";
  readonly model: string;
  private client: Anthropic;
  private defaultOptions: GenerateOptions;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: ProviderOptions) {
    this.model = options.model;
    this.defaultOptions = options.defaultOptions ?? {};
    this.baseUrl = options.baseUrl || "https://api.anthropic.com/v1";
    this.apiKey = options.apiKey ?? "";

    // The SDK appends /v1/messages itself, so a base URL ending in /v1 would yield /v1/v1/...
    this.client = new Anthropic({
      apiKey: this.apiKey,
      baseURL: this.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, ""),
    });
  }

  /** Same master switch as the OpenAI-compatible path, so the protocol can be flipped for
   *  every provider at once instead of one behaving differently from the rest. */
  supportsNativeTools(): boolean {
    const flag = (process.env["DUCKI_NATIVE_TOOLS"] ?? "").trim().toLowerCase();
    return !(flag === "0" || flag === "false" || flag === "off" || flag === "no");
  }

  private buildRequest(
    messages: LLMMessage[],
    merged: GenerateOptions
  ): Anthropic.MessageCreateParamsNonStreaming {
    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: merged.maxTokens ?? 4000,
      messages: toAnthropicMessages(messages),
    };

    const system = buildSystemBlocks(messages);
    if (system) request.system = system as unknown as Anthropic.MessageCreateParams["system"];
    if (merged.temperature !== undefined) request.temperature = merged.temperature;
    if (this.supportsNativeTools() && merged.tools && merged.tools.length > 0) {
      request.tools = toAnthropicTools(merged.tools) as unknown as Anthropic.Tool[];
    }

    return Object.assign(request, claudeReasoningOptions(this.model, merged));
  }

  async generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse> {
    const merged = { ...this.defaultOptions, ...options };
    const response = await this.client.messages.create(this.buildRequest(messages, merged), {
      signal: merged.signal,
    });

    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    const usage = response.usage as Anthropic.Usage & CachingUsage;
    const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;

    const result: LLMResponse = {
      content,
      usage: {
        // Anthropic reports cache reads/writes SEPARATELY from input_tokens, so the honest
        // total has to add them back in - otherwise a well-cached run looks like it consumed
        // almost no input at all.
        promptTokens: response.usage.input_tokens + cachedInputTokens + cacheWriteTokens,
        completionTokens: response.usage.output_tokens,
        totalTokens:
          response.usage.input_tokens + cachedInputTokens + cacheWriteTokens + response.usage.output_tokens,
        cachedInputTokens,
        cacheWriteTokens,
      },
      model: response.model,
      finishReason: response.stop_reason ?? undefined,
    };

    const toolCalls = fromAnthropicToolUse(response.content);
    if (toolCalls) result.toolCalls = toolCalls;
    return result;
  }

  async generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions,
    onChunk?: (chunk: string) => void
  ): Promise<LLMResponse> {
    const merged = { ...this.defaultOptions, ...options };
    const stream = this.client.messages.stream(this.buildRequest(messages, merged), {
      signal: merged.signal,
    });

    let fullContent = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedInputTokens = 0;
    let cacheWriteTokens = 0;
    let finishReason: string | undefined;

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        fullContent += chunk.delta.text;
        onChunk?.(chunk.delta.text);
      }

      if (chunk.type === "message_start" && chunk.message.usage) {
        const startUsage = chunk.message.usage as Anthropic.Usage & CachingUsage;
        cachedInputTokens = startUsage.cache_read_input_tokens ?? 0;
        cacheWriteTokens = startUsage.cache_creation_input_tokens ?? 0;
        promptTokens = startUsage.input_tokens + cachedInputTokens + cacheWriteTokens;
      }

      if (chunk.type === "message_delta" && chunk.usage) {
        completionTokens = chunk.usage.output_tokens;
        finishReason = chunk.delta.stop_reason || undefined;
      }
    }

    // tool_use blocks arrive as streamed input_json deltas; the SDK reassembles them, so read
    // the finished message rather than trying to stitch the partial JSON together here.
    const finalMessage = await stream.finalMessage();
    const toolCalls = fromAnthropicToolUse(finalMessage.content);

    const result: LLMResponse = {
      content: fullContent,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        cachedInputTokens,
        cacheWriteTokens,
      },
      model: this.model,
      finishReason,
    };
    if (toolCalls) result.toolCalls = toolCalls;
    return result;
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

  async listModels(): Promise<Array<{ id: string; name: string }>> {
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
