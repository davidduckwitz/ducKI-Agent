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
  /** Context window size in tokens, when the server reports one. The OpenAI API itself never
   *  does; local OpenAI-compatible servers (LM Studio in particular) often include it as an
   *  extra, non-standard field on each /v1/models entry. Undefined, not 0, when unknown - the
   *  UI must be able to tell "no data" apart from "context window is zero". */
  contextLength?: number;
}

export interface ProviderOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  defaultOptions?: GenerateOptions;
}
