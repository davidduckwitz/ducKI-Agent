import type { TextToSpeechProvider, TextToSpeechResult, TextToSpeechSynthesizeOptions } from "@ducki/shared";

export interface TextToSpeechProviderOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  voice?: string;
}

export abstract class BaseTextToSpeechProvider implements TextToSpeechProvider {
  abstract readonly name: string;

  constructor(protected readonly options: TextToSpeechProviderOptions) {}

  abstract synthesize(text: string, options?: TextToSpeechSynthesizeOptions): Promise<TextToSpeechResult>;
}
