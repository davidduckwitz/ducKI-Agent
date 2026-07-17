import { OpenAIProvider } from "./openai-provider.js";
import type { ProviderOptions } from "./base.js";
export declare class OpenRouterProvider extends OpenAIProvider {
    readonly name = "openrouter";
    constructor(options: Partial<ProviderOptions> & {
        model: string;
    });
}
//# sourceMappingURL=openrouter-provider.d.ts.map