import type { LLMMessage, LLMResponse, GenerateOptions } from "@ducki/shared";
import type { LLMProvider, ProviderOptions } from "./base.js";
export declare class OpenAIProvider implements LLMProvider {
    readonly name: string;
    readonly model: string;
    private client;
    private defaultOptions;
    private readonly maxRetries;
    private readonly baseRetryDelayMs;
    constructor(options: ProviderOptions);
    private getStatusCode;
    private getRetryAfterMs;
    private isRateLimitError;
    private createRetryDelayMs;
    private withRateLimitRetry;
    generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse>;
    generateStream(messages: LLMMessage[], options?: GenerateOptions, onChunk?: (chunk: string) => void): Promise<LLMResponse>;
    supportsStreaming(): boolean;
    isAvailable(): Promise<boolean>;
}
//# sourceMappingURL=openai-provider.d.ts.map