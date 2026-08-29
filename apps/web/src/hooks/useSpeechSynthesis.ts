import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceSettings } from "./useVoiceSettings";
import { registerActivePlayback } from "../lib/voicePlaybackRegistry";

export interface UseSpeechSynthesisResult {
  /** Cancels anything in-flight/queued and speaks `text` immediately (manual play button, retries). */
  speak: (text: string) => void;
  /** Appends `text` to the playback queue without interrupting what's currently speaking - used for sentence-by-sentence streaming. */
  enqueue: (text: string) => void;
  stop: () => void;
  isPlaying: boolean;
  isSpeaking: boolean;
  isSupported: boolean;
  error: string | null;
}

export function useSpeechSynthesis(): UseSpeechSynthesisResult {
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ttsLanguage, ttsSpeed, ttsPitch, ttsVolume, ttsProvider, ttsVoice, ttsEmotionStyle } = useVoiceSettings();

  const queueRef = useRef<string[]>([]);
  const playingRef = useRef(false);
  const stoppingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Bumped by stop() so an in-flight server TTS fetch/playback from a discarded turn never
  // reports errors or triggers the next queue item after the fact.
  const generationRef = useRef(0);

  const isSupported = typeof window !== "undefined";

  const buildUtterance = useCallback(
    (text: string) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = ttsLanguage;
      utterance.rate = ttsSpeed;
      utterance.pitch = ttsPitch;
      utterance.volume = ttsVolume;
      return utterance;
    },
    [ttsLanguage, ttsSpeed, ttsPitch, ttsVolume]
  );

  // Fetches synthesized audio from the server TTS backend (OpenAI/ElevenLabs) and plays it.
  // Resolves once playback ends (or fails) so the caller can move on to the next queue item.
  const playServerAudio = useCallback(
    async (text: string, generation: number): Promise<void> => {
      try {
        const response = await fetch("/api/chat/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            voice: ttsVoice || undefined,
            emotionStyle: ttsEmotionStyle,
          }),
        });

        if (generation !== generationRef.current) return; // superseded by stop()/speak() meanwhile

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `TTS-Anfrage fehlgeschlagen (${response.status})`);
        }

        const payload = (await response.json()) as { data?: { audio: string; mimeType: string } };
        const result = payload.data;
        if (!result || generation !== generationRef.current) return;

        const audioEl = new Audio(`data:${result.mimeType};base64,${result.audio}`);
        audioEl.volume = ttsVolume;
        audioEl.playbackRate = ttsSpeed;
        audioRef.current = audioEl;

        await new Promise<void>((resolve) => {
          audioEl.onplay = () => {
            if (generation === generationRef.current) setIsPlaying(true);
          };
          audioEl.onended = () => resolve();
          audioEl.onerror = () => resolve();
          audioEl.play().catch(() => resolve());
        });
      } catch (err) {
        if (generation === generationRef.current) {
          const message = err instanceof Error ? err.message : "Unbekannter Fehler";
          setError(`Fehler bei der Sprachausgabe: ${message}`);
        }
      }
    },
    [ttsVoice, ttsEmotionStyle, ttsVolume, ttsSpeed]
  );

  const playNext = useCallback(() => {
    if (playingRef.current) return; // already draining the queue

    const next = queueRef.current.shift();
    if (!next) {
      setIsPlaying(false);
      return;
    }

    playingRef.current = true;

    if (ttsProvider === "web-speech-api") {
      if (!window.speechSynthesis) {
        setError("Sprachausgabe wird von diesem Browser nicht unterstützt.");
        playingRef.current = false;
        return;
      }

      const utterance = buildUtterance(next);
      utterance.onstart = () => setIsPlaying(true);
      utterance.onend = () => {
        playingRef.current = false;
        playNext();
      };
      utterance.onerror = (event) => {
        // A deliberate stop() cancels the current utterance, which fires onerror with
        // "canceled"/"interrupted" - that's expected, not a real playback failure.
        if (!stoppingRef.current && event.error !== "canceled" && event.error !== "interrupted") {
          setError(`Fehler bei der Sprachausgabe: ${event.error}`);
        }
        playingRef.current = false;
        playNext();
      };
      window.speechSynthesis.speak(utterance);
    } else {
      const generation = generationRef.current;
      void playServerAudio(next, generation).then(() => {
        playingRef.current = false;
        if (generation === generationRef.current) playNext();
      });
    }
  }, [buildUtterance, playServerAudio, ttsProvider]);

  const stop = useCallback(() => {
    setError(null);
    setIsPlaying(false);
    queueRef.current = [];
    playingRef.current = false;
    generationRef.current += 1;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      stoppingRef.current = true;
      window.speechSynthesis.cancel();
      stoppingRef.current = false;
    }
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      stop();
      queueRef.current.push(text);
      playNext();
    },
    [stop, playNext]
  );

  const enqueue = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      queueRef.current.push(text);
      playNext();
    },
    [playNext]
  );

  // Lets a single display-level control stop every currently-speaking instance at once (see
  // voicePlaybackRegistry.ts) - registered only while this instance is actually playing.
  useEffect(() => {
    if (!isPlaying) return;
    return registerActivePlayback(stop);
  }, [isPlaying, stop]);

  return {
    speak,
    enqueue,
    stop,
    isPlaying,
    isSpeaking: isPlaying,
    isSupported,
    error,
  };
}
