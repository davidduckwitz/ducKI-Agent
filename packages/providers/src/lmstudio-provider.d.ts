import { OpenAIProvider } from "./openai-provider.js";
import type { ProviderOptions } from "./base.js";
export declare class LMStudioProvider extends OpenAIProvider {
    readonly name = "lmstudio";
    constructor(options: Partial<ProviderOptions> & {
        model?: string;
    });
}
//# sourceMappingURL=lmstudio-provider.d.ts.map