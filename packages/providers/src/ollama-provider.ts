// Ollama uses OpenAI-compatible API endpoint but with different image handling
// Ollama expects: { role, content, images: [base64_raw] } not { role, content: [{type: "image_url", ...}] }
import OpenAI from "openai";
import { OpenAIProvider } from "./openai-provider.js";
import type { ProviderOptions } from "./base.js";
import type { LLMMessage, LLMResponse, GenerateOptions, LLMContent } from "@ducki/shared";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

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
    console.log("[DEBUG OllamaProvider.generate] Called with", messages.length, "messages");
    const merged = { ...this.getDefaultOptions?.() ?? {}, ...options };

    // Transform messages: extract images and keep text separate
    const transformedMessages: ChatCompletionMessageParam[] = [];
    const messageImages: Map<number, string[]> = new Map(); // Track images per message index

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue; // Skip undefined messages
      const { message, images } = transformMessageForOllama(msg);

      // DEBUG: Log transformations
      if (images && images.length > 0) {
        console.log(`[DEBUG OllamaProvider] Message ${i}: Found ${images.length} images`);
      }

      transformedMessages.push(message);
      if (images && images.length > 0) {
        messageImages.set(i, images);
      }
    }

    console.log("[DEBUG OllamaProvider.generate] Transformed messages, messageImages map size:", messageImages.size);

    try {
      const client = (this as any).client as OpenAI;

      // Create a custom fetch that injects images into the request body
      const originalFetch = (this as any).customFetch ?? fetch;
      const customFetchWithImages = async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await originalFetch(input, init);

        // If this is a chat completions request, we need to modify it
        // But we can't modify a response... we need to intercept the request
        // This approach won't work. We need a different strategy.

        return response;
      };

      // Actually, we need to intercept BEFORE the request is sent
      // Let's use a different approach: make the request ourselves
      const requestBody = {
        model: this.model,
        messages: this.enrichMessagesWithImages(transformedMessages, messageImages),
        temperature: merged.temperature,
        top_p: merged.topP,
        max_tokens: merged.maxTokens,
        stream: false,
      };

      const response = await (originalFetch ?? fetch)(
        `${(this as any).endpoint}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.getAuthHeaders?.()),
          },
          body: JSON.stringify(requestBody),
        }
      );

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const completion = await response.json() as any;
      const choice = completion.choices?.[0];
      if (!choice) throw new Error("No completion choice returned");

      return {
        content: choice.message?.content || "",
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
