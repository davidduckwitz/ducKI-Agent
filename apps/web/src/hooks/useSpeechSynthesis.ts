import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceSettings } from "./useVoiceSettings";
import { registerActivePlayback } from "../lib/voicePlaybackRegistry";
import { splitForSpeech } from "../lib/splitForSpeech";
import { observeVoiceElement } from "../lib/voiceOutputAnalyser";

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
  const { ttsLanguage, ttsSpeed, ttsPitch, ttsVolume, ttsProvider, ttsVoice, ttsEmotionStyle, ttsEmotionInstructions } =
    useVoiceSettings();

  const queueRef = useRef<string[]>([]);
  const playingRef = useRef(false);
  const stoppingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const releaseOutputRef = useRef<(() => void) | null>(null);
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

  // Fetches synthesized audio from the server TTS backend (OpenAI/ElevenLabs/Chatterbox/...).
  // Split into two phases (synthesize, then play) rather than one function that does both and
  // resolves on playback-end: playNext's prefetch below needs to kick off the NEXT chunk's
  // synthesis as soon as the CURRENT chunk starts playing, not after it finishes. Chatterbox in
  // particular can take several seconds per sentence to generate (an autoregressive model, not
  // something a request-level setting can speed up) - without this overlap, a multi-sentence
  // reply pays that generation time again as dead silence between every sentence, on top of the
  // model's own per-sentence latency.
  const synthesizeServerAudio = useCallback(
    async (text: string, generation: number): Promise<{ audio: string; mimeType: string } | null> => {
      try {
        const response = await fetch("/api/chat/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            voice: ttsVoice || undefined,
            emotionStyle: ttsEmotionStyle,
            emotionInstructions: ttsEmotionInstructions || undefined,
            language: ttsLanguage || undefined,
          }),
        });

        if (generation !== generationRef.current) return null; // superseded by stop()/speak() meanwhile

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `TTS-Anfrage fehlgeschlagen (${response.status})`);
        }

        const payload = (await response.json()) as { data?: { audio: string; mimeType: string } };
        return payload.data ?? null;
      } catch (err) {
        if (generation === generationRef.current) {
          const message = err instanceof Error ? err.message : "Unbekannter Fehler";
          setError(`Fehler bei der Sprachausgabe: ${message}`);
        }
        return null;
      }
    },
    [ttsVoice, ttsEmotionStyle, ttsEmotionInstructions, ttsLanguage]
  );

  const playAudioResult = useCallback(
    (result: { audio: string; mimeType: string }, generation: number): Promise<void> => {
      const audioEl = new Audio(`data:${result.mimeType};base64,${result.audio}`);
      audioEl.volume = ttsVolume;
      audioEl.playbackRate = ttsSpeed;
      audioRef.current = audioEl;
      let release: (() => void) | undefined;
      try { release = observeVoiceElement(audioEl); } catch { /* Playback remains available without Web Audio. */ }

      return new Promise<void>((resolve) => {
        const finish = () => {
          release?.();
          release = undefined;
          if (releaseOutputRef.current === finish) releaseOutputRef.current = null;
          resolve();
        };
        releaseOutputRef.current = finish;
        audioEl.onplay = () => {
          if (generation === generationRef.current) setIsPlaying(true);
        };
        audioEl.onended = finish;
        audioEl.onerror = finish;
        audioEl.play().catch(finish);
      });
    },
    [ttsVolume, ttsSpeed]
  );

  // Holds a chunk that's already been synthesized (or is being synthesized) ahead of when it's
  // needed for playback - see the prefetch call in playNext below.
  const prefetchRef = useRef<{ text: string; promise: Promise<{ audio: string; mimeType: string } | null> } | null>(null);

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
      // Use the prefetched synthesis if playNext already started it ahead of time for this exact
      // chunk (see the prefetch kick-off below); otherwise synthesize it now (first chunk of a
      // queue, or the prefetch got superseded).
      const pending =
        prefetchRef.current?.text === next ? prefetchRef.current.promise : synthesizeServerAudio(next, generation);
      prefetchRef.current = null;

      void pending
        .then(async (result) => {
          if (result && generation === generationRef.current) {
            // Kick off the NEXT queued chunk's synthesis now, in parallel with this chunk's
            // playback, instead of waiting for playback to end first - this is what actually
            // closes the gap, since Chatterbox's own generation time doesn't shrink otherwise.
            const upcoming = queueRef.current[0];
            if (upcoming) prefetchRef.current = { text: upcoming, promise: synthesizeServerAudio(upcoming, generation) };
            await playAudioResult(result, generation);
          }
        })
        .finally(() => {
          playingRef.current = false;
          if (generation === generationRef.current) playNext();
        });
    }
  }, [buildUtterance, synthesizeServerAudio, playAudioResult, ttsProvider]);

  const stop = useCallback(() => {
    setError(null);
    setIsPlaying(false);
    queueRef.current = [];
    playingRef.current = false;
    generationRef.current += 1;
    // Not strictly required for correctness (the stale promise's own generation check already
    // makes playNext ignore it), but avoids a same-text coincidence reusing a discarded prefetch.
    prefetchRef.current = null;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    releaseOutputRef.current?.();
    if (typeof window !== "undefined" && window.speechSynthesis) {
      stoppingRef.current = true;
      window.speechSynthesis.cancel();
      stoppingRef.current = false;
    }
  }, []);

  // Splits before queuing - text handed to speak()/enqueue() from outside this hook (a manual
  // "read aloud" click on an already-complete message, or a full message replay) is never
  // pre-chunked the way useStreamingSpeech's own incremental flush is, so without this a long
  // message goes to a server TTS provider as one oversized request and gets rejected outright
  // (Chatterbox: 400 over ~2000 chars) - the exact "click play, nothing happens" failure mode
  // this fixes, not just the live-streaming case.
  const enqueueSplit = useCallback((text: string) => {
    for (const piece of splitForSpeech(text)) queueRef.current.push(piece);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      stop();
      enqueueSplit(text);
      playNext();
    },
    [stop, enqueueSplit, playNext]
  );

  const enqueue = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      enqueueSplit(text);
      playNext();
    },
    [enqueueSplit, playNext]
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
