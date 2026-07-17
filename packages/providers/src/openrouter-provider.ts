// OpenRouter uses OpenAI-compatible API
import { OpenAIProvider } from "./openai-provider.js";
import type { ProviderOptions } from "./base.js";

export class OpenRouterProvider extends OpenAIProvider {
  override readonly name = "openrouter";

  constructor(options: Partial<ProviderOptions> & { model: string }) {
    super({
      baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1",
      apiKey: options.apiKey ?? process.env["OPENROUTER_API_KEY"],
      model: options.model,
      defaultOptions: options.defaultOptions,
    });
  }
}
