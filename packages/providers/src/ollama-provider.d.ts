import { OpenAIProvider } from "./openai-provider.js";
import type { ProviderOptions } from "./base.js";
export declare class OllamaProvider extends OpenAIProvider {
    readonly name = "ollama";
    constructor(options: Partial<ProviderOptions> & {
        model?: string;
    });
}
//# sourceMappingURL=ollama-provider.d.ts.map