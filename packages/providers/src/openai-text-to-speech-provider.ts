import { BaseTextToSpeechProvider, type TextToSpeechProviderOptions } from "./text-to-speech-base.js";
import type { TextToSpeechResult, TextToSpeechSynthesizeOptions } from "@ducki/shared";

// Only OpenAI's newer gpt-4o-mini-tts model honors the "instructions" style-direction field -
// tts-1/tts-1-hd silently ignore it. Same preset->phrase mapping idea as the Breeze provider's
// PRESET_TO_INSTRUCTION, reused here so the Voice-tab's 5 presets behave consistently across
// every provider that supports natural-language style steering.
const PRESET_TO_INSTRUCTION: Record<string, string> = {
  neutral: "calm, even, neutral delivery",
  calm: "slow, gentle, soothing, relaxed tone",
  empathetic: "warm, caring, softly reassuring tone",
  cheerful: "upbeat, warm, smiling, friendly tone",
  excited: "energetic, enthusiastic, animated delivery",
};

function supportsInstructions(model: string): boolean {
  return model.startsWith("gpt-4o-mini-tts");
}

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

    const model = this.options.model ?? "tts-1";
    const instructions =
      options?.emotionInstructions || (options?.emotionStyle ? PRESET_TO_INSTRUCTION[options.emotionStyle] : undefined);

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        voice: options?.voice || this.options.voice || "alloy",
        input: text,
        ...(instructions && supportsInstructions(model) ? { instructions } : {}),
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
