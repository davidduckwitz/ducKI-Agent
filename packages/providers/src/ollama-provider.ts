// Ollama uses OpenAI-compatible API endpoint but with different image handling
// Ollama expects: { role, content, images: [base64_raw] } not { role, content: [{type: "image_url", ...}] }
import { OpenAIProvider, toOpenAITools, fromOpenAIToolCalls } from "./openai-provider.js";
import type { ProviderOptions } from "./base.js";
import type { LLMMessage, LLMResponse, GenerateOptions, LLMContent } from "@ducki/shared";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { getRootLogger } from "@ducki/logger";

const logger = getRootLogger().child("OllamaProvider");

function transformMessageForOllama(message: LLMMessage): { message: ChatCompletionMessageParam; images?: string[] } {
  // Only transform user messages with content arrays
  if (message.role !== "user" || typeof message.content === "string") {
    return { message: { role: message.role as any, content: message.content as string } };
  }

  if (!Array.isArray(message.content)) {
    return { message: { role: message.role as any, content: message.content as string } };
  }

  const content = message.content as LLMContent[];
  const images: string[] = [];
  const textParts: string[] = [];

  // Separate images from text
  for (const part of content) {
    if (part.type === "image_url") {
      const url = part.image_url?.url ?? "";
      // Extract raw base64 from data: URL
      const base64Match = url.match(/^data:[^;]*;base64,(.+)$/);
      if (base64Match?.[1]) {
        images.push(base64Match[1]);
      } else if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/")) {
        // URL is not in data: format - this is expected to have been handled by agent
        // Log warning for debugging but don't fail
        console.warn(
          "[OllamaProvider] Image URL is not in data: format. Agent should convert to data:base64 URL.",
          {
            url: url.substring(0, 100) + (url.length > 100 ? "..." : ""),
            format: "Expected: data:image/png;base64,<data>, Got: relative or http URL",
            provider: "ollama",
            tip: "This usually means the screenshot fetch in agent.ts didn't complete successfully",
          }
        );
      } else {
        // Unknown URL format
        console.warn("[OllamaProvider] Unknown image URL format", {
          url: url.substring(0, 100),
        });
      }
    } else if (part.type === "text") {
      textParts.push(part.text);
    }
  }

  const textContent = textParts.join("\n\n");
  const result: any = { message: { role: "user", content: textContent } };

  if (images.length > 0) {
    result.images = images;
  }

  return result;
}

export class OllamaProvider extends OpenAIProvider {
  override readonly name = "ollama";

  constructor(options: Partial<ProviderOptions> & { model?: string }) {
    const baseUrl = options.baseUrl ?? process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
    super({
      baseUrl: `${baseUrl}/v1`,
      apiKey: options.apiKey ?? "ollama",
      model: options.model ?? process.env["OLLAMA_MODEL"] ?? "llama3",
      defaultOptions: options.defaultOptions,
    });
  }

  /**
   * Override generate to convert LLMContent[] with image_url to Ollama's separate images field.
   * We transform messages and add a custom fetch handler to inject images into the API request.
   */
  override async generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse> {
    logger.debug("generate() called", { messageCount: messages.length });
    const merged = { ...this.getDefaultOptions?.() ?? {}, ...options };

    // Transform messages: extract images and keep text separate
    const transformedMessages: ChatCompletionMessageParam[] = [];
    const messageImages: Map<number, string[]> = new Map(); // Track images per message index

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue; // Skip undefined messages
      const { message, images } = transformMessageForOllama(msg);

      if (images && images.length > 0) {
        logger.debug("Found images in message", { index: i, imageCount: images.length });
      }

      transformedMessages.push(message);
      if (images && images.length > 0) {
        messageImages.set(i, images);
      }
    }

    logger.debug("Transformed messages", { messageImagesMapSize: messageImages.size });

    try {
      // Actually, we need to intercept BEFORE the request is sent
      // Let's use a different approach: make the request ourselves
      const originalFetch = (this as any).customFetch ?? fetch;
      const endpoint = `${(this as any).endpoint}/chat/completions`;
      const authHeaders = { "Content-Type": "application/json", ...(this.getAuthHeaders?.()) };
      const enrichedMessages = this.enrichMessagesWithImages(transformedMessages, messageImages);

      // This custom fetch path bypassed the base class's native tool-calling entirely: no
      // `tools`/`tool_choice` were ever sent, and `choice.message.tool_calls` was never read
      // back. supportsNativeTools() (inherited) still reported true, so the agent believed
      // structured tool calls were available and skipped straight to trusting them - meaning
      // every non-streaming Ollama call (sync fallback, low-temperature utility calls) fell
      // through to the far more fragile text `[TOOL:...]` protocol with no native path to
      // catch it, even though this exact model/backend combination could have used one.
      const useNativeTools = this.supportsNativeTools() && (merged.tools?.length ?? 0) > 0;
      const buildBody = (withTools: boolean) => ({
        model: this.model,
        messages: enrichedMessages,
        temperature: merged.temperature,
        top_p: merged.topP,
        max_tokens: merged.maxTokens,
        ...(merged.frequencyPenalty !== undefined ? { frequency_penalty: merged.frequencyPenalty } : {}),
        ...(merged.presencePenalty !== undefined ? { presence_penalty: merged.presencePenalty } : {}),
        stream: false,
        ...(withTools && merged.tools ? { tools: toOpenAITools(merged.tools), tool_choice: "auto" as const } : {}),
      });

      const doFetch = (withTools: boolean) =>
        (originalFetch ?? fetch)(endpoint, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(buildBody(withTools)),
          // Previously omitted entirely, so Stop's abortController.abort() never actually
          // cancelled an in-flight Ollama request - the generation ran to completion
          // regardless, and only the NEXT iteration check noticed stopRequested.
          signal: merged.signal,
        });

      let response = await doFetch(useNativeTools);

      // Same self-healing fallback as the base class's generate(): a backend that doesn't
      // implement `tools` rejects it with a 400 naming the param - disable native tools for
      // this instance and retry once without them instead of failing the whole run.
      if (!response.ok && useNativeTools && response.status === 400 && !this.nativeToolsUnsupported) {
        const bodyText = await response.clone().text().catch(() => "");
        if (/\btools?\b|function[_ -]?call|tool[_ -]?choice|unsupported|not supported/i.test(bodyText)) {
          this.nativeToolsUnsupported = true;
          response = await doFetch(false);
        }
      }

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const completion = await response.json() as any;
      const choice = completion.choices?.[0];
      if (!choice) throw new Error("No completion choice returned");

      return {
        content: choice.message?.content || "",
        toolCalls: fromOpenAIToolCalls(choice.message?.tool_calls),
        usage: {
          promptTokens: completion.usage?.prompt_tokens ?? 0,
          completionTokens: completion.usage?.completion_tokens ?? 0,
          totalTokens: completion.usage?.total_tokens ?? 0,
          estimated: !completion.usage,
        },
        finishReason: choice.finish_reason,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Override generateStream to convert LLMContent[] with image_url to Ollama's separate
   * images field, same as generate() above. The inherited OpenAIProvider.generateStream()
   * sends OpenAI-style content-array image blocks that Ollama's chat endpoint doesn't
   * accept, so a streamed vision turn (the default - supportsStreaming() is true) silently
   * lost the image even when generate() handled it correctly. Only messages actually
   * carrying image content take this path; everything else defers to the base
   * implementation so its retry/native-tools/stream_options handling stays intact.
   */
  override async generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions,
    onChunk?: (chunk: string) => void
  ): Promise<LLMResponse> {
    const hasImages = messages.some(
      (msg) =>
        msg.role === "user" &&
        Array.isArray(msg.content) &&
        (msg.content as LLMContent[]).some((part) => part.type === "image_url" || part.type === "image_data")
    );

    if (!hasImages) {
      return super.generateStream(messages, options, onChunk);
    }

    logger.debug("generateStream() called with image content", { messageCount: messages.length });
    const merged = { ...this.getDefaultOptions?.() ?? {}, ...options };

    const transformedMessages: ChatCompletionMessageParam[] = [];
    const messageImages: Map<number, string[]> = new Map();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;
      const { message, images } = transformMessageForOllama(msg);
      transformedMessages.push(message);
      if (images && images.length > 0) messageImages.set(i, images);
    }

    const originalFetch = (this as any).customFetch ?? fetch;
    // Same gap as generate() above, for the vision-with-tools case: this custom SSE reader
    // never sent `tools` and never accumulated `delta.tool_calls`, so a screenshot-analysis
    // turn that also needed to call a tool had no native path at all.
    const useNativeTools = this.supportsNativeTools() && (merged.tools?.length ?? 0) > 0;
    const enrichedMessages = this.enrichMessagesWithImages(transformedMessages, messageImages);
    const buildBody = (withTools: boolean) => ({
      model: this.model,
      messages: enrichedMessages,
      temperature: merged.temperature,
      top_p: merged.topP,
      max_tokens: merged.maxTokens,
      ...(merged.frequencyPenalty !== undefined ? { frequency_penalty: merged.frequencyPenalty } : {}),
      ...(merged.presencePenalty !== undefined ? { presence_penalty: merged.presencePenalty } : {}),
      stream: true,
      ...(withTools && merged.tools ? { tools: toOpenAITools(merged.tools), tool_choice: "auto" as const } : {}),
    });
    const endpoint = `${(this as any).endpoint}/chat/completions`;
    const authHeaders = { "Content-Type": "application/json", ...(this.getAuthHeaders?.()) };
    const doFetch = (withTools: boolean) =>
      originalFetch(endpoint, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(buildBody(withTools)),
        signal: merged.signal,
      });

    let response = await doFetch(useNativeTools);

    // A 400 rejecting `tools` can only be told apart from other errors by reading the body,
    // which requires an ok-or-not check first - the streaming body itself is consumed below.
    if (!response.ok && useNativeTools && response.status === 400 && !this.nativeToolsUnsupported) {
      const bodyText = await response.clone().text().catch(() => "");
      if (/\btools?\b|function[_ -]?call|tool[_ -]?choice|unsupported|not supported/i.test(bodyText)) {
        this.nativeToolsUnsupported = true;
        response = await doFetch(false);
      }
    }

    if (!response.ok || !response.body) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    let fullContent = "";
    let finalModel = this.model;
    let finalFinishReason: string | undefined;
    let promptTokens = 0;
    let completionTokens = 0;
    let reportedUsage = false;
    // Streamed tool_calls arrive as fragments keyed by array index - name and id on the
    // first fragment, `arguments` accumulated in pieces across subsequent ones. Same shape
    // the base OpenAIProvider.generateStream() accumulates for the non-vision path.
    const toolCallAccumulator = new Map<number, { id?: string; name?: string; arguments: string }>();

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data);
          const choice0 = chunk.choices?.[0];
          const delta = choice0?.delta?.content ?? "";
          if (delta) {
            fullContent += delta;
            onChunk?.(delta);
          }
          for (const tc of choice0?.delta?.tool_calls ?? []) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            const entry = toolCallAccumulator.get(idx) ?? { arguments: "" };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            toolCallAccumulator.set(idx, entry);
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? 0;
            completionTokens = chunk.usage.completion_tokens ?? 0;
            reportedUsage = promptTokens > 0 || completionTokens > 0;
          }
          finalModel = chunk.model ?? finalModel;
          finalFinishReason = choice0?.finish_reason ?? finalFinishReason;
        } catch {
          // Malformed/partial SSE line (can happen at chunk boundaries) - skip it.
        }
      }
    }

    const toolCalls = fromOpenAIToolCalls(
      [...toolCallAccumulator.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([, v]) => v.name)
        .map(([idx, v]) => ({
          id: v.id || `call_${idx}`,
          type: "function" as const,
          function: { name: v.name!, arguments: v.arguments || "{}" },
        }))
    );

    return {
      content: fullContent,
      toolCalls,
      usage: reportedUsage
        ? { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: false }
        : { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: true },
      model: finalModel,
      finishReason: finalFinishReason,
    };
  }

  /**
   * Enrich messages with images field where applicable.
   * Ollama expects images at the message level, not in content array.
   */
  private enrichMessagesWithImages(
    messages: ChatCompletionMessageParam[],
    imageMap: Map<number, string[]>
  ): any[] {
    return messages.map((msg, index) => {
      const images = imageMap.get(index);
      if (!images || images.length === 0) {
        return msg;
      }
      return { ...msg, images };
    });
  }

  private getAuthHeaders() {
    const apiKey = (this as any).apiKey ?? "";
    if (!apiKey || apiKey === "ollama" || apiKey === "lm-studio") {
      return {};
    }
    return { Authorization: `Bearer ${apiKey}` };
  }

  private getDefaultOptions() {
    return (this as any).defaultOptions ?? {};
  }
}
