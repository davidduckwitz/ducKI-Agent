// LM Studio uses OpenAI-compatible API but with different image handling
// Expects: { role, content: [...], images: [base64_raw] } not { role, content: [{type: "image_url", ...}] }
import OpenAI from "openai";
import { OpenAIProvider } from "./openai-provider.js";
import type { ProviderOptions } from "./base.js";
import type { LLMMessage, LLMResponse, GenerateOptions, LLMContent } from "@ducki/shared";
import { getRootLogger } from "@ducki/logger";

const logger = getRootLogger().child("LMStudioProvider");

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

    logger.debug("Initializing with storedApiKey", {
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

      logger.debug("Intercepting chat/completions request", { omitAuth, hasToken: !!normalizedApiKey });

      // Handle auth headers
      const headers = new Headers(init?.headers ?? {});

      if (omitAuth) {
        // Remove Authorization header if no auth needed
        headers.delete("Authorization");
        logger.debug("Removed Authorization header (omitAuth=true)");
      } else if (normalizedApiKey) {
        // Add Authorization header with Bearer token if we have a key
        headers.set("Authorization", `Bearer ${normalizedApiKey}`);
        logger.debug("Set Authorization header with token");
      } else {
        logger.warn("customFetch: no token to set for Authorization header");
      }

      const finalInit = { ...init, headers };

      // LM Studio's OpenAI-compatible endpoint accepts the STANDARD OpenAI vision format directly:
      //   content: [{ type: "text", ... }, { type: "image_url", image_url: { url: "data:image/..." } }]
      // An earlier version rewrote images into a non-standard top-level `images` field and flattened
      // content to a string. Current LM Studio ignores that shape, so the vision model silently
      // received NO image. Pass the body through unchanged (standard format); only adjust auth headers.
      return fetch(input, finalInit);
    };

    // Create new OpenAI client with custom fetch
    self.client = new OpenAI({
      apiKey: omitAuth ? "sk-no-auth-required" : normalizedApiKey,
      baseURL,
      fetch: customFetch,
    });

    logger.debug("Replaced client with custom fetch handler", { omitAuth });
  }

  private getDefaultOptions() {
    return (this as any).defaultOptions ?? {};
  }
}
