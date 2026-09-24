import { useEffect, useRef, useState } from "react";
import { useSpeechSynthesis } from "./useSpeechSynthesis";
import { useVoiceSettings } from "./useVoiceSettings";
import { stripMarkdownForSpeech } from "../lib/stripMarkdownForSpeech";
import { providerSupportsRealtimeStreaming } from "../lib/ttsProviderCapabilities";
import { createStreamingAudioPlayer, type StreamingAudioPlayer } from "../lib/streamingAudioPlayer";
import { splitForSpeech } from "../lib/splitForSpeech";
import { onVoiceReplyInterrupted } from "../lib/voiceCaptureBus";
import { useAppStore } from "../lib/store";
import { speechFlushBoundary } from "../lib/speechFlushBoundary";

/**
 * Speaks `streamingContent` as it grows, instead of waiting for `status === "complete"`.
 *
 * Two playback paths, chosen per ttsProvider (see providerSupportsRealtimeStreaming):
 *  - Non-streaming providers (openai/elevenlabs/piper/local/web-speech-api): unchanged
 *    behavior - buffer up to the next full sentence, then hand it to useSpeechSynthesis's
 *    per-sentence HTTP fetch-and-play queue.
 *  - Streaming-capable providers (chatterbox/breeze): flush smaller, more frequent chunks into
 *    a persistent per-turn StreamingAudioPlayer (apps/server's dedicated audio WebSocket),
 *    which schedules PCM chunks back-to-back as they arrive - see the voice-mode plan's Phase C
 *    for why this exists (removing the "wait for the whole sentence's audio, then fetch the
 *    next one" pauses of the HTTP path).
 *
 * Only active while `active` is true (gated by ttsStreamingMode/autoPlayTTS/enableTTS in the
 * caller). On unmount (the message finishing and StreamingRow being replaced by MessageRow)
 * it flushes whatever trailing text never reached a sentence boundary, so nothing is lost -
 * VoicePlayback's own autoplay-on-complete stays off while streaming mode is on to avoid
 * speaking the same content twice.
 *
 * Returns `isPlaying` so the caller can signal "the agent finished talking" for hands-free
 * continuous conversation (see useAgentTurnEndSignal).
 */
export function useStreamingSpeech(streamingContent: string, active: boolean): { isPlaying: boolean } {
  const { enqueue, stop, isPlaying: sentenceIsPlaying } = useSpeechSynthesis();
  const interruptedRef = useRef(false);
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    const offInterrupt = onVoiceReplyInterrupted(() => {
      interruptedRef.current = true;
      stopRef.current();
      playerRef.current?.stop();
    });
    const offStore = useAppStore.subscribe((state, previous) => {
      if (state.isLoading && !previous.isLoading) interruptedRef.current = false;
    });
    return () => { offInterrupt(); offStore(); };
  }, []);
  const { ttsStripMarkdown, ttsProvider, ttsVoice, ttsEmotionStyle, ttsEmotionInstructions, ttsLanguage, ttsVolume, ttsSpeed } =
    useVoiceSettings();

  const streaming = providerSupportsRealtimeStreaming(ttsProvider);
  const [streamIsPlaying, setStreamIsPlaying] = useState(false);
  const playerRef = useRef<StreamingAudioPlayer | null>(null);
  // A block boundary hands off from one player instance to the next while the old one is still
  // finishing its queued/in-flight audio (see the "" reset branch below: it calls end(), not
  // stop(), so the outgoing player keeps playing and keeps reporting its own isPlaying via the
  // callback registered below). Two independent players can therefore both be "live" briefly -
  // naively wiring each one's onPlayingChange straight to setStreamIsPlaying lets the OLD
  // player's later false (its last source finishing) stomp the NEW player's true, firing a
  // premature isPlaying-false transition (and therefore a premature "turn ended" signal, see
  // useAgentTurnEndSignal) while the new block is still actively speaking. Track "is ANY live
  // player currently playing" instead of taking the latest raw callback value verbatim.
  const livePlayerCountRef = useRef(0);

  const spokenUpToRef = useRef(0);
  const lastRawRef = useRef("");
  const lastFlushAtRef = useRef(0);
  const enqueueRef = useRef(enqueue);
  const stripRef = useRef(ttsStripMarkdown);
  const activeRef = useRef(active);
  const streamingRef = useRef(streaming);
  enqueueRef.current = enqueue;
  stripRef.current = ttsStripMarkdown;
  activeRef.current = active;
  streamingRef.current = streaming;

  const stopStreamPlayer = () => {
    playerRef.current?.stop();
    playerRef.current = null;
  };

  const ensureStreamPlayer = (): StreamingAudioPlayer => {
    if (!playerRef.current) {
      const player = createStreamingAudioPlayer({
        voice: ttsVoice || undefined,
        emotionStyle: ttsEmotionStyle,
        emotionInstructions: ttsEmotionInstructions || undefined,
        language: ttsLanguage || undefined,
        volume: ttsVolume,
        playbackRate: ttsSpeed,
      });
      player.onPlayingChange((playing) => {
        livePlayerCountRef.current = Math.max(0, livePlayerCountRef.current + (playing ? 1 : -1));
        setStreamIsPlaying(livePlayerCountRef.current > 0);
      });
      player.start();
      playerRef.current = player;
    }
    return playerRef.current;
  };

  const speakChunk = (text: string) => {
    if (interruptedRef.current) return;
    const spoken = stripRef.current ? stripMarkdownForSpeech(text) : text;
    if (!spoken.trim()) return;
    if (streamingRef.current) {
      ensureStreamPlayer().pushText(spoken);
    } else {
      enqueueRef.current(spoken);
    }
  };

  // Every flush point below hands over a BATCH of text that may span multiple sentences (see
  // splitForSpeech.ts for why a single oversized batch is a real bug, not just a theoretical
  // one) - route all of them through splitForSpeech so no single speakChunk/enqueue call ever
  // exceeds a size a server TTS provider will actually accept. Order is preserved
  // (enqueue appends to a FIFO queue, and pushText appends to the realtime player's stream), so
  // splitting a batch into several calls here still plays back in the original order.
  const speakBatch = (text: string) => {
    for (const piece of splitForSpeech(text)) speakChunk(piece);
  };

  useEffect(() => {
    if (streamingContent === "") {
      // A block just committed (or the whole turn ended) - streamingContent resets to "" both
      // between blocks of a single multi-tool-call run (see store.ts's assistant_text handling,
      // which fires once per committed text block, not just once per run) and at the very end.
      // The trailing fragment that never crossed a sentence boundary (or the streaming char
      // threshold) must be spoken NOW, before the refs are cleared - relying on the unmount-flush
      // effect below to catch it doesn't work here, because StreamingRow's component instance
      // survives across blocks of the same run (it only truly unmounts once, at the very end),
      // so by the time it unmounts this branch has already run and wiped lastRawRef/spokenUpToRef
      // to empty, leaving nothing for that effect to flush. Previously this branch discarded the
      // remainder unconditionally, which is why replies with no terminal punctuation - or any
      // non-final block of a multi-block turn - could show correct bubble text but never be
      // spoken at all.
      if (activeRef.current) {
        const remainder = lastRawRef.current.slice(spokenUpToRef.current).trim();
        if (remainder) speakBatch(remainder);
      }
      spokenUpToRef.current = 0;
      lastRawRef.current = "";
      lastFlushAtRef.current = 0;
      // Let the realtime player finish playing whatever was just queued (including the
      // remainder above) instead of aborting it - stopStreamPlayer()/.stop() tears the
      // connection down immediately and drops any not-yet-played audio, which was cutting off
      // the tail end of every non-final block. The next block gets a fresh player from
      // ensureStreamPlayer() on its first speakChunk call.
      if (streamingRef.current) {
        playerRef.current?.end();
        playerRef.current = null;
      } else {
        stopStreamPlayer();
      }
      return;
    }

    if (!active) {
      lastRawRef.current = streamingContent;
      return;
    }

    const raw = streamingContent;
    const prevRaw = lastRawRef.current;

    // Reflection/verify passes can rewrite the tail after we've already spoken part of it -
    // if the new text diverges from what we scanned before, only trust the common prefix.
    const maxCommon = Math.min(prevRaw.length, raw.length);
    let commonLength = 0;
    while (commonLength < maxCommon && prevRaw[commonLength] === raw[commonLength]) commonLength++;
    if (commonLength < spokenUpToRef.current) {
      spokenUpToRef.current = commonLength;
    }

    const unspoken = raw.slice(spokenUpToRef.current);
    const boundary = streaming
      ? speechFlushBoundary(unspoken, spokenUpToRef.current === 0, ttsProvider === "chatterbox")
      : (() => {
            let end = 0;
            for (const match of unspoken.matchAll(/[.!?]["')\]]*\s+|\n+/g)) {
              end = match.index + match[0].length;
            }
            return end;
        })();
    if (boundary > 0) {
      speakBatch(unspoken.slice(0, boundary).trim());
      spokenUpToRef.current += boundary;
      lastFlushAtRef.current = Date.now();
    }

    lastRawRef.current = raw;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamingContent, active, streaming]);

  // Flush the unspoken trailing fragment when this turn's streaming view unmounts (message
  // completed and got replaced by the permanent MessageRow).
  //
  // React 18 StrictMode (dev only) double-invokes a fresh effect's cleanup as setup -> cleanup
  // -> setup, simulating an unmount that doesn't really happen. A plain `return () => flush()`
  // would fire that simulated cleanup immediately at mount time (speaking whatever partial
  // remainder existed then) and fire again for the real unmount later - the deferred/cancelable
  // timeout below only lets the flush actually run if no following setup cancels it first,
  // which is exactly what happens on the simulated cleanup but not on the real unmount.
  const pendingFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (pendingFlushRef.current !== null) {
      clearTimeout(pendingFlushRef.current);
      pendingFlushRef.current = null;
    }
    return () => {
      if (!activeRef.current) return;
      pendingFlushRef.current = setTimeout(() => {
        pendingFlushRef.current = null;
        const remainder = lastRawRef.current.slice(spokenUpToRef.current).trim();
        if (remainder) {
          spokenUpToRef.current = lastRawRef.current.length;
          speakBatch(remainder);
        }
        if (streamingRef.current) playerRef.current?.end();
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tear down a still-open streaming session if the component unmounts entirely (not just the
  // turn ending, which the "" reset above already handles).
  useEffect(() => {
    return () => stopStreamPlayer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isPlaying: streaming ? streamIsPlaying : sentenceIsPlaying };
}
