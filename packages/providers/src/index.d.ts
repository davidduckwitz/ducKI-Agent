import type { LLMProvider } from "./base.js";
import { OpenAIProvider } from "./openai-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import { LMStudioProvider } from "./lmstudio-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
export type ProviderName = "openai" | "openrouter" | "lmstudio" | "ollama";
export interface ProviderFactoryConfig {
    name: ProviderName;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
}
export declare function createProvider(config: ProviderFactoryConfig): LLMProvider;
export declare function createDefaultProvider(): LLMProvider;
export { OpenAIProvider, OpenRouterProvider, LMStudioProvider, OllamaProvider };
export type { LLMProvider };
export * from "./base.js";
//# sourceMappingURL=index.d.ts.map