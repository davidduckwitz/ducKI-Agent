import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TTSProvider = "web-speech-api" | "openai" | "silero";

export interface VoiceSettings {
  // STT Settings
  enableSTT: boolean;
  sttLanguage: string;

  // TTS Settings
  enableTTS: boolean;
  ttsProvider: TTSProvider;
  ttsLanguage: string;
  ttsSpeed: number; // 0.5 to 2.0
  ttsPitch: number; // 0.5 to 2.0
  ttsVolume: number; // 0 to 1

  // Advanced
  autoPlayTTS: boolean;
  ttsQuality: "low" | "high"; // for OpenAI/Silero: tts-1 vs tts-1-hd
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enableSTT: true,
  sttLanguage: "de-DE",

  enableTTS: true,
  ttsProvider: "web-speech-api",
  ttsLanguage: "de-DE",
  ttsSpeed: 1.0,
  ttsPitch: 1.0,
  ttsVolume: 1.0,

  autoPlayTTS: false,
  ttsQuality: "high",
};

interface VoiceSettingsStore extends VoiceSettings {
  setEnableSTT: (enable: boolean) => void;
  setSTTLanguage: (lang: string) => void;

  setEnableTTS: (enable: boolean) => void;
  setTTSProvider: (provider: TTSProvider) => void;
  setTTSLanguage: (lang: string) => void;
  setTTSSpeed: (speed: number) => void;
  setTTSPitch: (pitch: number) => void;
  setTTSVolume: (volume: number) => void;

  setAutoPlayTTS: (autoPlay: boolean) => void;
  setTTSQuality: (quality: "low" | "high") => void;

  reset: () => void;
}

export const useVoiceSettings = create<VoiceSettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_VOICE_SETTINGS,

      setEnableSTT: (enable) => set({ enableSTT: enable }),
      setSTTLanguage: (lang) => set({ sttLanguage: lang }),

      setEnableTTS: (enable) => set({ enableTTS: enable }),
      setTTSProvider: (provider) => set({ ttsProvider: provider }),
      setTTSLanguage: (lang) => set({ ttsLanguage: lang }),
      setTTSSpeed: (speed) => set({ ttsSpeed: Math.max(0.5, Math.min(2, speed)) }),
      setTTSPitch: (pitch) => set({ ttsPitch: Math.max(0.5, Math.min(2, pitch)) }),
      setTTSVolume: (volume) => set({ ttsVolume: Math.max(0, Math.min(1, volume)) }),

      setAutoPlayTTS: (autoPlay) => set({ autoPlayTTS: autoPlay }),
      setTTSQuality: (quality) => set({ ttsQuality: quality }),

      reset: () => set(DEFAULT_VOICE_SETTINGS),
    }),
    {
      name: "ducki-voice-settings",
    }
  )
);
