// LM Studio uses OpenAI-compatible API
import { OpenAIProvider } from "./openai-provider.js";
export class LMStudioProvider extends OpenAIProvider {
    name = "lmstudio";
    constructor(options) {
        super({
            baseUrl: options.baseUrl ?? process.env["LM_STUDIO_BASE_URL"] ?? "http://localhost:1234/v1",
            apiKey: options.apiKey ?? process.env["LM_STUDIO_API_KEY"],
            model: options.model ?? process.env["LM_STUDIO_MODEL"] ?? "local-model",
            defaultOptions: options.defaultOptions,
        });
    }
}
//# sourceMappingURL=lmstudio-provider.js.map