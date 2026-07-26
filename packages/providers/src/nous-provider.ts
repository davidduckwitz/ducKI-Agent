import { OpenAIProvider } from "./openai-provider.js";
import type { ProviderOptions } from "./base.js";

export class NousProvider extends OpenAIProvider {
  override readonly name: string = "nous";

  constructor(options: Partial<ProviderOptions> & { model?: string }) {
    super({
      baseUrl: options.baseUrl ?? process.env["NOUS_BASE_URL"] ?? "https://api.nousresearch.com/v1",
      apiKey: options.apiKey ?? process.env["NOUS_API_KEY"],
      model: options.model ?? process.env["NOUS_MODEL"] ?? "nous-hermes-2-mixtral-8x7b-dpo",
      defaultOptions: options.defaultOptions,
    });
  }
}
