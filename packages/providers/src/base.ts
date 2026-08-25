import type { LLMMessage, LLMResponse, GenerateOptions, ToolDefinition } from "@ducki/shared";

export type { LLMMessage, LLMResponse, GenerateOptions, ToolDefinition };

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse>;
  generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions,
    onChunk?: (chunk: string) => void
  ): Promise<LLMResponse>;
  supportsStreaming(): boolean;
  /** True when this provider can accept `options.tools` and return structured
   *  `LLMResponse.toolCalls` (native function-calling). Optional: absent/false means the
   *  caller should rely on the text `[TOOL:...]` protocol. */
  supportsNativeTools?(): boolean;
  isAvailable(): Promise<boolean>;
  /** Query the provider API for models available to the current credentials. */
  listModels?(): Promise<LLMModel[]>;
}

export interface LLMModel {
  id: string;
  name: string;
}

export interface ProviderOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  defaultOptions?: GenerateOptions;
}
