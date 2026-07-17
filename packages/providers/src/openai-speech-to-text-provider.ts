import { BaseSpeechToTextProvider, type SpeechToTextProviderOptions } from "./speech-to-text-base.js";

export class OpenAISpeechToTextProvider extends BaseSpeechToTextProvider {
  readonly name = "openai";

  async transcribe(audioBuffer: Buffer, options?: { language?: string }): Promise<string> {
    const apiKey = this.options.apiKey;
    if (!apiKey) {
      throw new Error("OpenAI API key is required for speech-to-text");
    }

    const formData = new FormData();
    const audioBytes = new Uint8Array(audioBuffer.byteLength);
    audioBytes.set(audioBuffer);
    const blob = new Blob([audioBytes], { type: "audio/mp3" });
    formData.append("file", blob, "audio.mp3");
    formData.append("model", "whisper-1");
    if (options?.language) {
      formData.append("language", options.language);
    }

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI Whisper failed: ${response.status} ${error}`);
    }

    const result = (await response.json()) as { text: string };
    return result.text;
  }
}
