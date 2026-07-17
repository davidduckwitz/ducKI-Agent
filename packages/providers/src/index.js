import { OpenAIProvider } from "./openai-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import { LMStudioProvider } from "./lmstudio-provider.js";
import { OllamaProvider } from "./ollama-provider.js";

export function createProvider(config) {
    switch (config.name) {
        case "openai":
            return new OpenAIProvider({
                baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
                apiKey: config.apiKey,
                model: config.model ?? process.env["OPENAI_MODEL"] ?? "gpt-4o",
            });
        case "openrouter":
            return new OpenRouterProvider({
                baseUrl: config.baseUrl,
                apiKey: config.apiKey,
                model: config.model ?? process.env["OPENROUTER_MODEL"] ?? "anthropic/claude-3-5-sonnet",
            });
        case "lmstudio":
            return new LMStudioProvider({
                baseUrl: config.baseUrl,
                apiKey: config.apiKey ?? process.env["LM_STUDIO_API_KEY"],
                model: config.model,
            });
        case "ollama":
            return new OllamaProvider({
                baseUrl: config.baseUrl,
                model: config.model,
            });
        default:
            throw new Error(`Unknown provider: ${String(config.name)}`);
    }
}

export function createDefaultProvider() {
    const providerName = process.env["DEFAULT_PROVIDER"];
    if (providerName === "lmstudio") {
        return createProvider({
            name: "lmstudio",
            apiKey: process.env["LM_STUDIO_API_KEY"],
            baseUrl: process.env["LM_STUDIO_BASE_URL"] ?? "http://localhost:1234/v1",
            model: process.env["LM_STUDIO_MODEL"] || "local-model",
        });
    }
    return createProvider({ name: providerName });
}

export { OpenAIProvider, OpenRouterProvider, LMStudioProvider, OllamaProvider };
export * from "./base.js";