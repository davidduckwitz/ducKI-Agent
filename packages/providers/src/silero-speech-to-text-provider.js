import { BaseSpeechToTextProvider } from "./speech-to-text-base.js";
/**
 * Local speech-to-text using Silero Models (runs locally, no API key needed).
 * Requires Ollama with speech-to-text model support or local Python environment.
 *
 * For Ollama: ollama pull silero-vad (for voice activity detection)
 * For local: pip install silero-vad silero-asr
 */
export class SileroSpeechToTextProvider extends BaseSpeechToTextProvider {
    name = "silero";
    async transcribe(audioBuffer, options) {
        // If Ollama endpoint is configured, use it
        if (this.options.baseUrl?.includes("ollama")) {
            return this.transcribeViaOllama(audioBuffer, options?.language);
        }
        // Fallback: Attempt to use local speech-to-text endpoint
        // This would require a local speech-to-text service running
        throw new Error("Silero speech-to-text requires either: (1) Ollama with speech model, or (2) local speech-to-text service");
    }
    async transcribeViaOllama(audioBuffer, language) {
        const baseUrl = this.options.baseUrl || "http://localhost:11434";
        // Convert audio buffer to base64 for transmission
        const base64Audio = audioBuffer.toString("base64");
        try {
            const response = await fetch(`${baseUrl}/api/generate`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: this.options.model || "silero-asr",
                    prompt: base64Audio,
                    stream: false,
                }),
            });
            if (!response.ok) {
                throw new Error(`Ollama failed: ${response.status}`);
            }
            const result = (await response.json());
            return result.response || "";
        }
        catch (error) {
            throw new Error(`Silero transcription via Ollama failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
//# sourceMappingURL=silero-speech-to-text-provider.js.map