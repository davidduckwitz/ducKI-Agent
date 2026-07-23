import { BaseSpeechToTextProvider } from "./speech-to-text-base.js";
/**
 * Local speech-to-text using Silero Models (runs locally, no API key needed).
 * Requires Ollama with speech-to-text model support or local Python environment.
 *
 * For Ollama: ollama pull silero-vad (for voice activity detection)
 * For local: pip install silero-vad silero-asr
 */
export declare class SileroSpeechToTextProvider extends BaseSpeechToTextProvider {
    readonly name = "silero";
    transcribe(audioBuffer: Buffer, options?: {
        language?: string;
    }): Promise<string>;
    private transcribeViaOllama;
}
//# sourceMappingURL=silero-speech-to-text-provider.d.ts.map