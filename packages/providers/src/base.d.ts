import type { LLMMessage, LLMResponse, GenerateOptions, ToolDefinition } from "@ducki/shared";
export type { LLMMessage, LLMResponse, GenerateOptions, ToolDefinition };
export interface LLMProvider {
    readonly name: string;
    readonly model: string;
    generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse>;
    generateStream(messages: LLMMessage[], options?: GenerateOptions, onChunk?: (chunk: string) => void): Promise<LLMResponse>;
    supportsStreaming(): boolean;
    isAvailable(): Promise<boolean>;
}
export interface ProviderOptions {
    baseUrl: string;
    apiKey?: string;
    model: string;
    defaultOptions?: GenerateOptions;
}
//# sourceMappingURL=base.d.ts.map