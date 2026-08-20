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

/**
 * The Messages API requires the conversation to start with a user turn and to alternate
 * roles. Our history does neither by construction: tool results are carried as their own
 * messages and all collapse onto `user`, and a context window cut can start on an assistant
 * turn. So adjacent same-role messages are merged into one (their content blocks simply
 * concatenate, which is exactly how the API models a multi-part turn) and a leading
 * assistant turn is dropped rather than sent to be rejected.
 */
function toAnthropicMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
  const mapped = messages
    .filter((m) => m.role !== "system")
    .map((m): Anthropic.MessageParam => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: convertLLMContentToAnthropic(m.content),
    }));

  while (mapped.length > 0 && mapped[0]!.role === "assistant") {
    mapped.shift();
  }

  const merged: Anthropic.MessageParam[] = [];
  for (const message of mapped) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      previous.content = [
        ...(previous.content as unknown as ContentBlockParamLike[]),
        ...(message.content as unknown as ContentBlockParamLike[]),
      ] as unknown as Anthropic.MessageParam["content"];
      continue;
    }
    merged.push(message);
  }

  return merged;
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

  constructor(options: ProviderOptions) {
    this.model = options.model;
    this.defaultOptions = options.defaultOptions ?? {};

    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: "https://api.anthropic.com/v1",
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

    return request;
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
}
