import type { SpeechToTextProvider } from "@ducki/shared";
export interface SpeechToTextProviderOptions {
    baseUrl: string;
    apiKey?: string;
    model?: string;
}
export declare abstract class BaseSpeechToTextProvider implements SpeechToTextProvider {
    protected readonly options: SpeechToTextProviderOptions;
    abstract readonly name: string;
    constructor(options: SpeechToTextProviderOptions);
    abstract transcribe(audioBuffer: Buffer, options?: {
        language?: string;
    }): Promise<string>;
}
//# sourceMappingURL=speech-to-text-base.d.ts.map