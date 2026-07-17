import type { SpeechToTextProvider } from "@ducki/shared";

export interface SpeechToTextProviderOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
}

export abstract class BaseSpeechToTextProvider implements SpeechToTextProvider {
  abstract readonly name: string;

  constructor(protected readonly options: SpeechToTextProviderOptions) {}

  abstract transcribe(audioBuffer: Buffer, options?: { language?: string }): Promise<string>;
}
