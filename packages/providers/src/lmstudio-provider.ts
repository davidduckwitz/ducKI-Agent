// LM Studio uses OpenAI-compatible API but with different image handling
// Expects: { role, content: [...], images: [base64_raw] } not { role, content: [{type: "image_url", ...}] }
import OpenAI from "openai";
import { OpenAIProvider } from "./openai-provider.js";
import type { ProviderOptions } from "./base.js";
import type { LLMMessage, LLMResponse, GenerateOptions, LLMContent } from "@ducki/shared";

export class LMStudioProvider extends OpenAIProvider {
  override readonly name = "lmstudio";
  private originalClient: any;
  private apiKeyForCustomFetch: string;

  constructor(options: Partial<ProviderOptions> & { model?: string }) {
    const baseUrl = options.baseUrl ?? process.env["LM_STUDIO_BASE_URL"] ?? "http://localhost:1234/v1";
    const apiKey = options.apiKey ?? process.env["LM_STUDIO_API_KEY"] ?? "";

    // Call parent constructor first
    super({
      baseUrl,
      apiKey,
      model: options.model ?? process.env["LM_STUDIO_MODEL"] ?? "local-model",
      defaultOptions: options.defaultOptions,
    });

    // Store for use in replaceClientWithCustomFetch
    this.apiKeyForCustomFetch = apiKey;

    // Now replace the client with one that has our custom fetch handler
    this.replaceClientWithCustomFetch();
  }

  /**
   * Replace the OpenAI client with one that has a custom fetch handler
   * for converting image_url to separate images field.
   */
  private replaceClientWithCustomFetch() {
    const self = this as any;
    const apiKey = this.apiKeyForCustomFetch;
    const baseURL = self.endpoint;

    // Use the same logic as OpenAIProvider
    const normalizedApiKey = apiKey.replace(/^Bearer\s+/i, "").trim();
    const normalized = normalizedApiKey.toLowerCase();
    const omitAuth = !normalized ||
      ["lm-studio", "not-needed", "none", "null", "undefined"].includes(normalized);

    console.log("[DEBUG LMStudioProvider] Initializing with storedApiKey:", {
      hasApiKey: !!apiKey,
      normalizedLength: normalizedApiKey.length,
      omitAuth,
    });

    // Create custom fetch that transforms messages for LM Studio
    const customFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();

      // Only intercept chat completions requests
      if (!url.includes("/chat/completions")) {
        return fetch(input, init);
      }

      console.log("[DEBUG LMStudioProvider.customFetch] Intercepting chat/completions request, omitAuth:", omitAuth, "hasToken:", !!normalizedApiKey);

      // Handle auth headers
      const headers = new Headers(init?.headers ?? {});

      if (omitAuth) {
        // Remove Authorization header if no auth needed
        headers.delete("Authorization");
        console.log("[DEBUG LMStudioProvider.customFetch] Removed Authorization header (omitAuth=true)");
      } else if (normalizedApiKey) {
        // Add Authorization header with Bearer token if we have a key
        headers.set("Authorization", `Bearer ${normalizedApiKey}`);
        console.log("[DEBUG LMStudioProvider.customFetch] Set Authorization header with token");
      } else {
        console.log("[DEBUG LMStudioProvider.customFetch] WARNING: No token to set!");
      }

      let finalInit = { ...init, headers };

      // Parse and transform the request body
      if (!init?.body || typeof init.body !== "string") {
        console.log("[DEBUG LMStudioProvider.customFetch] No body to transform, sending as-is");
        return fetch(input, finalInit);
      }

      try {
        const body = JSON.parse(init.body) as any;
        const messages = body.messages as any[];
        if (!Array.isArray(messages)) {
          return fetch(input, init);
        }

        // Transform messages: extract image_url and create separate images field
        const transformedMessages = messages.map((msg) => {
          if (msg.role !== "user" || !Array.isArray(msg.content)) {
            return msg;
          }

          const images: string[] = [];
          const contentWithoutImages: any[] = [];

          // Separate images from content array
          for (const part of msg.content) {
            if (part.type === "image_url") {
              const imgUrl = part.image_url?.url ?? "";
              // Extract raw base64 from data: URL
              const base64Match = imgUrl.match(/^data:[^;]*;base64,(.+)$/);
              if (base64Match?.[1]) {
                images.push(base64Match[1]);
                console.log(`[DEBUG LMStudioProvider.customFetch] Extracted ${base64Match[1].substring(0, 50)}...`);
              }
            } else {
              contentWithoutImages.push(part);
            }
          }

          // If we found images, modify the message
          if (images.length > 0) {
            console.log(`[DEBUG LMStudioProvider.customFetch] Message has ${images.length} images, converting to images field`);
            // IMPORTANT: content MUST be a string for LM Studio, not an array!
            const textContent = contentWithoutImages.length > 0
              ? contentWithoutImages.map((part: any) => part.text || "").filter(Boolean).join("\n")
              : "Analyze the attached image";
            return {
              ...msg,
              content: textContent,
              images,
            };
          }

          return msg;
        });

        // Rebuild request body with transformed messages
        const newBody = JSON.stringify({ ...body, messages: transformedMessages });

        console.log("[DEBUG LMStudioProvider.customFetch] Sending to LM Studio with transformed messages");

        // DEBUG: Log the exact request structure for messages with images
        const messagesWithImages = transformedMessages.filter((m: any) => m.images && m.images.length > 0);
        if (messagesWithImages.length > 0) {
          console.log("[DEBUG LMStudioProvider.customFetch] Messages with images:", {
            count: messagesWithImages.length,
            firstMessage: {
              role: messagesWithImages[0].role,
              contentType: typeof messagesWithImages[0].content,
              imageCount: messagesWithImages[0].images?.length,
              imageSizes: messagesWithImages[0].images?.map((img: string) => img.length),
            }
          });
        }

        // Update headers: fix Content-Length since body changed
        // IMPORTANT: Use finalInit headers (which have Authorization) as base!
        const newHeaders = new Headers(finalInit.headers);
        newHeaders.set("Content-Length", Buffer.byteLength(newBody).toString());

        // Send modified request with updated headers
        return fetch(input, { ...finalInit, headers: newHeaders, body: newBody });
      } catch (error) {
        console.error("[DEBUG LMStudioProvider.customFetch] Error:", error);
        // On error, still send with finalInit to preserve auth headers
        return fetch(input, finalInit);
      }
    };

    // Create new OpenAI client with custom fetch
    self.client = new OpenAI({
      apiKey: omitAuth ? "sk-no-auth-required" : normalizedApiKey,
      baseURL,
      fetch: customFetch,
    });

    console.log("[DEBUG LMStudioProvider] Replaced client with custom fetch handler (omitAuth:", omitAuth, ")");
  }

  private getDefaultOptions() {
    return (this as any).defaultOptions ?? {};
  }
}
