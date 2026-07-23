import { BaseSpeechToTextProvider } from "./speech-to-text-base.js";
export declare class OpenAISpeechToTextProvider extends BaseSpeechToTextProvider {
    readonly name = "openai";
    transcribe(audioBuffer: Buffer, options?: {
        language?: string;
    }): Promise<string>;
}
//# sourceMappingURL=openai-speech-to-text-provider.d.ts.map