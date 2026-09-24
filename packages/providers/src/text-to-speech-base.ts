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

/**
 * Optional capability a provider can additionally implement for low-latency playback: instead
 * of returning one Promise<Buffer> for the whole utterance, it yields raw PCM chunks as they
 * become available. Kept as a separate interface (not a change to TextToSpeechProvider) so the
 * existing batch synthesize() path and every provider that only implements it stay untouched.
 */
export interface StreamingTextToSpeechProvider {
  /** Sample rate (Hz) of the PCM chunks yielded by synthesizeStream, mono 16-bit signed LE. */
  readonly streamSampleRate: number;
  synthesizeStream(text: string, options?: TextToSpeechSynthesizeOptions): AsyncIterable<Buffer>;
}

export function isStreamingTextToSpeechProvider(
  provider: TextToSpeechProvider
): provider is TextToSpeechProvider & StreamingTextToSpeechProvider {
  return typeof (provider as Partial<StreamingTextToSpeechProvider>).synthesizeStream === "function";
}
