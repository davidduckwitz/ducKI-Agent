/**
 * Server-side text-to-speech pipeline for the /api/chat/speak endpoint (used when the
 * Voice-tab's TTS provider is set to something other than the browser's Web Speech API).
 * Mirrors audio-transcription.ts's settings-driven provider construction.
 */
import type { DatabaseService } from "@ducki/database";
import { createTextToSpeechProvider, type TextToSpeechProviderFactoryConfig } from "@ducki/providers";

function readSetting(settings: Map<string, string>, key: string, defaultValue?: string): string | undefined {
  return settings.get(key) || defaultValue;
}

export interface SynthesizeSpeechOptions {
  voice?: string;
  emotionStyle?: string;
}

export interface SynthesizeSpeechResult {
  audio: Buffer;
  mimeType: string;
}

export async function synthesizeSpeech(
  db: DatabaseService,
  text: string,
  opts: SynthesizeSpeechOptions = {}
): Promise<SynthesizeSpeechResult> {
  const allSettings = await db.getAllSettings();
  const settingsMap = new Map(allSettings.map((s) => [s.key, s.value]));

  const providerName = (readSetting(settingsMap, "DEFAULT_TEXT_TO_SPEECH_PROVIDER", "openai") ?? "openai") as
    | "openai"
    | "elevenlabs"
    | "piper"
    | "local";

  let config: TextToSpeechProviderFactoryConfig;
  switch (providerName) {
    case "elevenlabs":
      config = {
        name: "elevenlabs",
        apiKey: readSetting(settingsMap, "ELEVENLABS_API_KEY"),
        model: readSetting(settingsMap, "ELEVENLABS_MODEL", "eleven_multilingual_v2"),
        voice: opts.voice || readSetting(settingsMap, "ELEVENLABS_VOICE_ID"),
        stability: Number.parseFloat(readSetting(settingsMap, "ELEVENLABS_STABILITY", "0.5") ?? "0.5"),
        similarityBoost: Number.parseFloat(readSetting(settingsMap, "ELEVENLABS_SIMILARITY_BOOST", "0.75") ?? "0.75"),
      };
      break;
    case "piper":
      config = {
        name: "piper",
        executablePath: readSetting(settingsMap, "PIPER_EXECUTABLE_PATH", "piper"),
        modelPath: opts.voice || readSetting(settingsMap, "PIPER_MODEL_PATH"),
        lengthScale: Number.parseFloat(readSetting(settingsMap, "PIPER_LENGTH_SCALE", "1") ?? "1"),
        noiseScale: Number.parseFloat(readSetting(settingsMap, "PIPER_NOISE_SCALE", "0.667") ?? "0.667"),
        noiseW: Number.parseFloat(readSetting(settingsMap, "PIPER_NOISE_W", "0.8") ?? "0.8"),
        sentenceSilence: Number.parseFloat(readSetting(settingsMap, "PIPER_SENTENCE_SILENCE", "0.2") ?? "0.2"),
        speakerId: (() => {
          const raw = readSetting(settingsMap, "PIPER_SPEAKER_ID");
          return raw ? Number.parseInt(raw, 10) : undefined;
        })(),
      };
      break;
    case "local":
      config = {
        name: "local",
        command: readSetting(settingsMap, "LOCAL_TTS_COMMAND"),
        args: (() => {
          const raw = readSetting(settingsMap, "LOCAL_TTS_ARGS");
          if (!raw?.trim().startsWith("[")) return undefined;
          try {
            const parsed = JSON.parse(raw) as unknown;
            return Array.isArray(parsed) ? parsed.map(String) : undefined;
          } catch {
            return undefined;
          }
        })(),
        workingDirectory: readSetting(settingsMap, "LOCAL_TTS_WORKDIR"),
        timeoutMs: Number.parseInt(readSetting(settingsMap, "LOCAL_TTS_TIMEOUT_MS", "60000") ?? "60000", 10),
        outputExt: readSetting(settingsMap, "LOCAL_TTS_OUTPUT_EXT", "wav"),
        model: readSetting(settingsMap, "LOCAL_TTS_MODEL"),
        voice: opts.voice,
      };
      break;
    default:
      config = {
        name: "openai",
        apiKey: readSetting(settingsMap, "OPENAI_API_KEY"),
        model: readSetting(settingsMap, "OPENAI_TTS_MODEL", "tts-1"),
        voice: opts.voice || readSetting(settingsMap, "OPENAI_TTS_VOICE", "alloy"),
      };
  }

  const provider = createTextToSpeechProvider(config);
  return provider.synthesize(text, { voice: opts.voice, emotionStyle: opts.emotionStyle });
}
