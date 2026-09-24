import type { TTSProvider } from "../hooks/useVoiceSettings";

/**
 * Providers that implement StreamingTextToSpeechProvider server-side (see
 * packages/providers/src/text-to-speech-base.ts) and can be driven incrementally through
 * apps/server/src/websocket/audio-stream.ts instead of the per-sentence HTTP path in
 * useSpeechSynthesis.ts. Single source of truth shared by useStreamingSpeech.ts (which picks
 * the playback path) and VoiceSettings.tsx (which can hint at this in the UI).
 */
export function providerSupportsRealtimeStreaming(provider: TTSProvider): boolean {
  return provider === "chatterbox" || provider === "breeze";
}

/**
 * Providers that honor a free-text emotion/delivery instruction (ttsEmotionInstructions)
 * instead of only the closed 5-value preset. OpenAI only honors it when the configured
 * OPENAI_TTS_MODEL is gpt-4o-mini-tts (tts-1/tts-1-hd silently ignore it) - the Voice tab
 * doesn't know which model is configured server-side, so it shows the field with a caveat
 * rather than hiding it outright.
 */
export function providerSupportsEmotionInstructions(provider: TTSProvider): boolean {
  return provider === "breeze" || provider === "openai";
}
