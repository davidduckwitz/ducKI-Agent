import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TTSProvider = "web-speech-api" | "openai" | "elevenlabs" | "piper" | "local" | "silero";
export type STTMode = "push-to-talk" | "vad-auto";
export type TTSEmotionStyle = "neutral" | "cheerful" | "calm" | "empathetic" | "excited";
export type AgentVoiceReplyStyle = "adapt" | "unchanged";

export interface VoiceSettings {
  // STT Settings
  enableSTT: boolean;
  sttLanguage: string;
  sttMode: STTMode;
  sttMaxRecordingMs: number;
  sttSilenceTimeoutMs: number;
  sttSilenceThreshold: number; // 0 to 1, RMS energy threshold for VAD
  sttMinSpeechMs: number;

  // TTS Settings
  enableTTS: boolean;
  ttsProvider: TTSProvider;
  ttsLanguage: string;
  ttsSpeed: number; // 0.5 to 2.0
  ttsPitch: number; // 0.5 to 2.0
  ttsVolume: number; // 0 to 1
  ttsVoice: string; // provider-specific voice id
  ttsStreamingMode: boolean; // speak sentence-by-sentence while agent is still streaming
  ttsEmotionStyle: TTSEmotionStyle;
  ttsStripMarkdown: boolean;

  // Conversation
  continuousConversationMode: boolean;
  agentVoiceReplyStyle: AgentVoiceReplyStyle;
  voiceRetryPromptEnabled: boolean;

  // Advanced
  autoPlayTTS: boolean;
  ttsQuality: "low" | "high"; // for OpenAI/Silero: tts-1 vs tts-1-hd
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enableSTT: true,
  sttLanguage: "de-DE",
  sttMode: "push-to-talk",
  sttMaxRecordingMs: 30000,
  sttSilenceTimeoutMs: 1200,
  sttSilenceThreshold: 0.02,
  sttMinSpeechMs: 300,

  enableTTS: true,
  ttsProvider: "web-speech-api",
  ttsLanguage: "de-DE",
  ttsSpeed: 1.0,
  ttsPitch: 1.0,
  ttsVolume: 1.0,
  ttsVoice: "",
  ttsStreamingMode: true,
  ttsEmotionStyle: "neutral",
  ttsStripMarkdown: true,

  continuousConversationMode: false,
  agentVoiceReplyStyle: "adapt",
  voiceRetryPromptEnabled: true,

  autoPlayTTS: false,
  ttsQuality: "high",
};

interface VoiceSettingsStore extends VoiceSettings {
  setEnableSTT: (enable: boolean) => void;
  setSTTLanguage: (lang: string) => void;
  setSTTMode: (mode: STTMode) => void;
  setSTTMaxRecordingMs: (ms: number) => void;
  setSTTSilenceTimeoutMs: (ms: number) => void;
  setSTTSilenceThreshold: (value: number) => void;
  setSTTMinSpeechMs: (ms: number) => void;

  setEnableTTS: (enable: boolean) => void;
  setTTSProvider: (provider: TTSProvider) => void;
  setTTSLanguage: (lang: string) => void;
  setTTSSpeed: (speed: number) => void;
  setTTSPitch: (pitch: number) => void;
  setTTSVolume: (volume: number) => void;
  setTTSVoice: (voice: string) => void;
  setTTSStreamingMode: (enabled: boolean) => void;
  setTTSEmotionStyle: (style: TTSEmotionStyle) => void;
  setTTSStripMarkdown: (enabled: boolean) => void;

  setContinuousConversationMode: (enabled: boolean) => void;
  setAgentVoiceReplyStyle: (style: AgentVoiceReplyStyle) => void;
  setVoiceRetryPromptEnabled: (enabled: boolean) => void;

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
      setSTTMode: (mode) => set({ sttMode: mode }),
      setSTTMaxRecordingMs: (ms) => set({ sttMaxRecordingMs: Math.max(3000, Math.min(120000, ms)) }),
      setSTTSilenceTimeoutMs: (ms) => set({ sttSilenceTimeoutMs: Math.max(300, Math.min(5000, ms)) }),
      setSTTSilenceThreshold: (value) => set({ sttSilenceThreshold: Math.max(0, Math.min(1, value)) }),
      setSTTMinSpeechMs: (ms) => set({ sttMinSpeechMs: Math.max(100, Math.min(3000, ms)) }),

      setEnableTTS: (enable) => set({ enableTTS: enable }),
      setTTSProvider: (provider) => set({ ttsProvider: provider }),
      setTTSLanguage: (lang) => set({ ttsLanguage: lang }),
      setTTSSpeed: (speed) => set({ ttsSpeed: Math.max(0.5, Math.min(2, speed)) }),
      setTTSPitch: (pitch) => set({ ttsPitch: Math.max(0.5, Math.min(2, pitch)) }),
      setTTSVolume: (volume) => set({ ttsVolume: Math.max(0, Math.min(1, volume)) }),
      setTTSVoice: (voice) => set({ ttsVoice: voice }),
      setTTSStreamingMode: (enabled) => set({ ttsStreamingMode: enabled }),
      setTTSEmotionStyle: (style) => set({ ttsEmotionStyle: style }),
      setTTSStripMarkdown: (enabled) => set({ ttsStripMarkdown: enabled }),

      setContinuousConversationMode: (enabled) => set({ continuousConversationMode: enabled }),
      setAgentVoiceReplyStyle: (style) => set({ agentVoiceReplyStyle: style }),
      setVoiceRetryPromptEnabled: (enabled) => set({ voiceRetryPromptEnabled: enabled }),

      setAutoPlayTTS: (autoPlay) => set({ autoPlayTTS: autoPlay }),
      setTTSQuality: (quality) => set({ ttsQuality: quality }),

      reset: () => set(DEFAULT_VOICE_SETTINGS),
    }),
    {
      name: "ducki-voice-settings",
    }
  )
);
