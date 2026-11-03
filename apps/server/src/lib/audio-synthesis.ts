/**
 * Server-side text-to-speech pipeline for the /api/chat/speak endpoint (used when the
 * Voice-tab's TTS provider is set to something other than the browser's Web Speech API).
 * Mirrors audio-transcription.ts's settings-driven provider construction.
 */
import type { DatabaseService } from "@ducki/database";
import { defaultReferenceVoice } from "./tts-voices.js";
import { createTextToSpeechProvider, type TextToSpeechProviderFactoryConfig, type TextToSpeechProvider } from "@ducki/providers";

function readSetting(settings: Map<string, string>, key: string, defaultValue?: string): string | undefined {
  return settings.get(key) || defaultValue;
}

const SERVER_TTS_PROVIDERS = new Set(["openai", "elevenlabs", "piper", "local", "chatterbox", "qwen3-tts", "pocket-tts", "breeze"]);

export interface SynthesizeSpeechOptions {
  /** Per-request engine chosen in the Voice tab; wins over the DEFAULT_TEXT_TO_SPEECH_PROVIDER setting. */
  provider?: string;
  voice?: string;
  emotionStyle?: string;
  emotionInstructions?: string;
  language?: string;
  /**
   * Per-request values for the TTS settings keys (CHATTERBOX_SERVER_URL, ELEVENLABS_API_KEY, ...)
   * that win over the stored settings for this call only - never persisted. Lets a plugin keep
   * its own engine configuration without touching the agent's Voice tab.
   */
  settingsOverride?: Record<string, string>;
}

export interface SynthesizeSpeechResult {
  audio: Buffer;
  mimeType: string;
}

/**
 * Builds the configured TTS provider from settings without calling synthesize() - shared by the
 * batch /api/chat/speak route (synthesizeSpeech below) and the streaming audio WebSocket
 * endpoint (websocket/audio-stream.ts), which needs the raw provider to check for
 * StreamingTextToSpeechProvider support and call synthesizeStream() itself.
 */
/** Stored settings with non-empty override values layered on top (overrides are not saved). */
export async function readTtsSettings(db: DatabaseService, override?: Record<string, string>): Promise<Map<string, string>> {
  const allSettings = await db.getAllSettings();
  const settingsMap = new Map(allSettings.map((s) => [s.key, s.value]));
  for (const [key, value] of Object.entries(override ?? {})) {
    if (typeof value === "string" && value.trim() !== "") settingsMap.set(key, value.trim());
  }
  return settingsMap;
}

export async function resolveTextToSpeechProvider(
  db: DatabaseService,
  opts: SynthesizeSpeechOptions = {}
): Promise<TextToSpeechProvider> {
  const settingsMap = await readTtsSettings(db, opts.settingsOverride);

  const requested = SERVER_TTS_PROVIDERS.has(opts.provider ?? "") ? opts.provider : undefined;
  const providerName = (requested ?? readSetting(settingsMap, "DEFAULT_TEXT_TO_SPEECH_PROVIDER", "chatterbox") ?? "chatterbox") as
    | "openai"
    | "elevenlabs"
    | "piper"
    | "local"
    | "chatterbox"
    | "qwen3-tts"
    | "pocket-tts"
    | "breeze";

  let config: TextToSpeechProviderFactoryConfig;
  switch (providerName) {
    case "pocket-tts":
      config = {
        name: "pocket-tts",
        serverUrl: readSetting(settingsMap, "POCKET_TTS_SERVER_URL", "http://127.0.0.1:8893"),
        voice: opts.voice || readSetting(settingsMap, "POCKET_TTS_DEFAULT_VOICE") || defaultReferenceVoice(),
      };
      break;
    case "qwen3-tts":
      config = {
        name: "qwen3-tts",
        serverUrl: readSetting(settingsMap, "QWEN_TTS_SERVER_URL", "http://127.0.0.1:8892"),
        voice: opts.voice || readSetting(settingsMap, "QWEN_TTS_DEFAULT_VOICE") || defaultReferenceVoice(),
      };
      break;
    case "chatterbox":
      config = {
        name: "chatterbox",
        serverUrl: readSetting(settingsMap, "CHATTERBOX_SERVER_URL", "http://127.0.0.1:8890"),
        voice: opts.voice || readSetting(settingsMap, "CHATTERBOX_DEFAULT_VOICE") || defaultReferenceVoice(),
        emotionExaggeration: Number.parseFloat(readSetting(settingsMap, "CHATTERBOX_EMOTION_EXAGGERATION", "0.5") ?? "0.5"),
      };
      break;
    case "breeze":
      config = {
        name: "breeze",
        apiKey: readSetting(settingsMap, "BREEZE_API_KEY"),
        wsUrl: readSetting(settingsMap, "BREEZE_WS_URL"),
        voice: opts.voice || readSetting(settingsMap, "BREEZE_DEFAULT_VOICE_ID"),
      };
      break;
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

  return createTextToSpeechProvider(config);
}

export async function synthesizeSpeech(
  db: DatabaseService,
  text: string,
  opts: SynthesizeSpeechOptions = {}
): Promise<SynthesizeSpeechResult> {
  const provider = await resolveTextToSpeechProvider(db, opts);
  return provider.synthesize(text, {
    voice: opts.voice,
    emotionStyle: opts.emotionStyle,
    emotionInstructions: opts.emotionInstructions,
    language: opts.language,
  });
}
