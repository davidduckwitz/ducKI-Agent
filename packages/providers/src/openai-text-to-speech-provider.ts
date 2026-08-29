import { BaseTextToSpeechProvider, type TextToSpeechProviderOptions } from "./text-to-speech-base.js";
import type { TextToSpeechResult, TextToSpeechSynthesizeOptions } from "@ducki/shared";

export class OpenAITextToSpeechProvider extends BaseTextToSpeechProvider {
  readonly name = "openai";

  constructor(options: TextToSpeechProviderOptions) {
    super(options);
  }

  async synthesize(text: string, options?: TextToSpeechSynthesizeOptions): Promise<TextToSpeechResult> {
    const apiKey = this.options.apiKey;
    if (!apiKey) {
      throw new Error("OpenAI API key is required for text-to-speech");
    }

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model ?? "tts-1",
        voice: options?.voice || this.options.voice || "alloy",
        input: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI TTS failed: ${response.status} ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return { audio: Buffer.from(arrayBuffer), mimeType: "audio/mpeg" };
  }
}
