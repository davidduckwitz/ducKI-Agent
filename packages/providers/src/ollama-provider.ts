// Ollama uses OpenAI-compatible API endpoint
import { OpenAIProvider } from "./openai-provider.js";
import type { ProviderOptions } from "./base.js";

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
}
