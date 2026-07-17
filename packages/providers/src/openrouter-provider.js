// OpenRouter uses OpenAI-compatible API
import { OpenAIProvider } from "./openai-provider.js";
export class OpenRouterProvider extends OpenAIProvider {
    name = "openrouter";
    constructor(options) {
        super({
            baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1",
            apiKey: options.apiKey ?? process.env["OPENROUTER_API_KEY"],
            model: options.model,
            defaultOptions: options.defaultOptions,
        });
    }
}
//# sourceMappingURL=openrouter-provider.js.map