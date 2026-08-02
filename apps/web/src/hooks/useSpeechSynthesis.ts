import { useCallback, useRef, useState } from "react";
import { useVoiceSettings } from "./useVoiceSettings";

export interface UseSpeechSynthesisResult {
  speak: (text: string) => void;
  stop: () => void;
  isPlaying: boolean;
  isSpeaking: boolean;
  isSupported: boolean;
  error: string | null;
}

export function useSpeechSynthesis(): UseSpeechSynthesisResult {
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ttsLanguage, ttsSpeed, ttsPitch, ttsVolume, ttsProvider } = useVoiceSettings();
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const isSupported = typeof window !== "undefined" && !!window.speechSynthesis;

  const stop = useCallback(() => {
    setError(null);
    setIsPlaying(false);
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    if (audioRef.current) {
      audioRef.current.pause();
    }
  }, []);

  const speak = useCallback(
    (text: string) => {
      setError(null);

      if (!isSupported) {
        setError("Sprachausgabe wird von diesem Browser nicht unterstützt.");
        return;
      }

      if (!text.trim()) return;

      try {
        if (ttsProvider === "web-speech-api") {
          // Stop any previous speech
          if (window.speechSynthesis.speaking) {
            window.speechSynthesis.cancel();
          }

          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = ttsLanguage;
          utterance.rate = ttsSpeed;
          utterance.pitch = ttsPitch;
          utterance.volume = ttsVolume;

          utterance.onstart = () => {
            setIsPlaying(true);
          };

          utterance.onend = () => {
            setIsPlaying(false);
          };

          utterance.onerror = (event) => {
            setIsPlaying(false);
            setError(`Fehler bei der Sprachausgabe: ${event.error}`);
          };

          utteranceRef.current = utterance;
          window.speechSynthesis.speak(utterance);
        } else {
          // Placeholder for OpenAI/Silero - würde auf Server-Endpoint aufrufen
          console.warn(`TTS Provider "${ttsProvider}" ist noch nicht implementiert`);
          setError(`TTS Provider "${ttsProvider}" ist noch nicht implementiert`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unbekannter Fehler";
        setError(`Fehler: ${message}`);
        setIsPlaying(false);
      }
    },
    [isSupported, ttsLanguage, ttsSpeed, ttsPitch, ttsVolume, ttsProvider]
  );

  return {
    speak,
    stop,
    isPlaying,
    isSpeaking: window.speechSynthesis?.speaking ?? false,
    isSupported,
    error,
  };
}
