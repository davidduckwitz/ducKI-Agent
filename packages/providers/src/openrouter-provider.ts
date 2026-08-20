// OpenRouter uses OpenAI-compatible API
import { OpenAIProvider } from "./openai-provider.js";
import type { ProviderOptions } from "./base.js";

export class OpenRouterProvider extends OpenAIProvider {
  override readonly name = "openrouter";

  /**
   * OpenRouter passes an explicit `cache_control` breakpoint through to Anthropic models,
   * where it is what makes a multi-iteration agent run reuse its (large, constant) system
   * prompt instead of paying full price for it on every iteration. Models without a prompt
   * cache ignore the extra field.
   */
  protected override emitsPromptCacheControl(): boolean {
    return true;
  }

  constructor(options: Partial<ProviderOptions> & { model: string }) {
    super({
      baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1",
      apiKey: options.apiKey ?? process.env["OPENROUTER_API_KEY"],
      model: options.model,
      defaultOptions: options.defaultOptions,
    });
  }
}
