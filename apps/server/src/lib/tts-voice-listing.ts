/**
 * Voice listing per TTS engine, shared by GET /api/chat/tts-voices (Voice tab) and the plugin
 * speech capability (plugins may pass their own server URLs / API keys as settingsOverride).
 * Every engine is normalized to {voiceId, name} so pickers need no provider-specific mapping.
 */
import type { DatabaseService } from "@ducki/database";
import { listElevenLabsVoices, listBreezeVoices, listChatterboxVoices, listQwen3Voices, listPocketVoices } from "@ducki/providers";
import { readTtsSettings } from "./audio-synthesis.js";

export interface TtsVoiceOption {
  voiceId: string;
  name: string;
}

export async function listTtsVoices(
  db: DatabaseService,
  provider: string,
  opts: { query?: string; settingsOverride?: Record<string, string> } = {}
): Promise<TtsVoiceOption[]> {
  const settings = await readTtsSettings(db, opts.settingsOverride);
  const settingValue = (key: string) => settings.get(key);

  if (provider === "elevenlabs") {
    const apiKey = settingValue("ELEVENLABS_API_KEY");
    return apiKey ? listElevenLabsVoices(apiKey) : [];
  }
  if (provider === "breeze") {
    const apiKey = settingValue("BREEZE_API_KEY");
    return apiKey ? listBreezeVoices(apiKey, opts.query) : [];
  }
  if (provider === "chatterbox") {
    const voices = await listChatterboxVoices(settingValue("CHATTERBOX_SERVER_URL") || "http://127.0.0.1:8890");
    return voices.map((v) => ({ voiceId: v.id, name: v.name }));
  }
  if (provider === "pocket-tts") {
    const voices = await listPocketVoices(settingValue("POCKET_TTS_SERVER_URL") || "http://127.0.0.1:8893");
    return voices.map((v) => ({ voiceId: v.id, name: v.name }));
  }
  if (provider === "qwen3-tts") {
    const voices = await listQwen3Voices(settingValue("QWEN_TTS_SERVER_URL") || "http://127.0.0.1:8892");
    return voices.map((v) => ({ voiceId: v.id, name: v.name }));
  }
  // OpenAI's voice set is a small fixed list - nothing worth a network round-trip for.
  return [];
}
