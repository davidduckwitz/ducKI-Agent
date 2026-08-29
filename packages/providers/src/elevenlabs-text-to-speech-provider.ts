import { BaseTextToSpeechProvider, type TextToSpeechProviderOptions } from "./text-to-speech-base.js";
import type { TextToSpeechResult, TextToSpeechSynthesizeOptions } from "@ducki/shared";

export interface ElevenLabsTextToSpeechProviderOptions extends TextToSpeechProviderOptions {
  stability?: number;
  similarityBoost?: number;
}

// ElevenLabs' `style` knob (0-1, only honored by v2 models) is the closest thing to an
// "emotion" dial the API exposes - map the coarse Voice-tab presets onto it instead of
// hardcoding a single value.
const EMOTION_STYLE_MAP: Record<string, number> = {
  neutral: 0,
  calm: 0.15,
  empathetic: 0.35,
  cheerful: 0.6,
  excited: 0.85,
};

export class ElevenLabsTextToSpeechProvider extends BaseTextToSpeechProvider {
  readonly name = "elevenlabs";
  private readonly stability: number;
  private readonly similarityBoost: number;

  constructor(options: ElevenLabsTextToSpeechProviderOptions) {
    super(options);
    this.stability = options.stability ?? 0.5;
    this.similarityBoost = options.similarityBoost ?? 0.75;
  }

  async synthesize(text: string, options?: TextToSpeechSynthesizeOptions): Promise<TextToSpeechResult> {
    const apiKey = this.options.apiKey;
    if (!apiKey) {
      throw new Error("ElevenLabs API key is required for text-to-speech");
    }
    const voiceId = options?.voice || this.options.voice;
    if (!voiceId) {
      throw new Error("ElevenLabs voice ID is required for text-to-speech");
    }

    const style = options?.emotionStyle ? EMOTION_STYLE_MAP[options.emotionStyle] : undefined;

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: this.options.model ?? "eleven_multilingual_v2",
        voice_settings: {
          stability: this.stability,
          similarity_boost: this.similarityBoost,
          ...(style !== undefined ? { style } : {}),
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ElevenLabs TTS failed: ${response.status} ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return { audio: Buffer.from(arrayBuffer), mimeType: "audio/mpeg" };
  }
}

export interface ElevenLabsVoiceSummary {
  voiceId: string;
  name: string;
}

export async function listElevenLabsVoices(apiKey: string): Promise<ElevenLabsVoiceSummary[]> {
  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs voice listing failed: ${response.status} ${error}`);
  }
  const data = (await response.json()) as { voices?: Array<{ voice_id: string; name: string }> };
  return (data.voices ?? []).map((v) => ({ voiceId: v.voice_id, name: v.name }));
}
