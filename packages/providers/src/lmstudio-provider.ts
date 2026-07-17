// LM Studio uses OpenAI-compatible API
import { OpenAIProvider } from "./openai-provider.js";
import type { ProviderOptions } from "./base.js";

export class LMStudioProvider extends OpenAIProvider {
  override readonly name = "lmstudio";

  constructor(options: Partial<ProviderOptions> & { model?: string }) {
    super({
      baseUrl: options.baseUrl ?? process.env["LM_STUDIO_BASE_URL"] ?? "http://localhost:1234/v1",
      apiKey: options.apiKey ?? process.env["LM_STUDIO_API_KEY"],
      model: options.model ?? process.env["LM_STUDIO_MODEL"] ?? "local-model",
      defaultOptions: options.defaultOptions,
    });
  }
}
