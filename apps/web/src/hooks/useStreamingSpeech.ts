import { useEffect, useRef } from "react";
import { useSpeechSynthesis } from "./useSpeechSynthesis";
import { useVoiceSettings } from "./useVoiceSettings";
import { stripMarkdownForSpeech } from "../lib/stripMarkdownForSpeech";

// Sentence end (. ! ?, optionally followed by a closing quote/bracket, then whitespace) or a
// paragraph break - matches what a listener would perceive as "a sentence just finished".
const SENTENCE_BREAK_RE = /[.!?]["')\]]*\s+|\n+/g;

/**
 * Speaks `streamingContent` sentence-by-sentence as it grows, instead of waiting for
 * `status === "complete"` - the agent already streams text chunk-by-chunk, this just starts
 * talking as soon as the first sentence is done instead of after the whole response.
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
  const { enqueue, isPlaying } = useSpeechSynthesis();
  const { ttsStripMarkdown } = useVoiceSettings();

  const spokenUpToRef = useRef(0);
  const lastRawRef = useRef("");
  const enqueueRef = useRef(enqueue);
  const stripRef = useRef(ttsStripMarkdown);
  const activeRef = useRef(active);
  enqueueRef.current = enqueue;
  stripRef.current = ttsStripMarkdown;
  activeRef.current = active;

  useEffect(() => {
    if (streamingContent === "") {
      // A new turn started - forget everything from the previous message.
      spokenUpToRef.current = 0;
      lastRawRef.current = "";
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
    let lastBreak = -1;
    let match: RegExpExecArray | null;
    SENTENCE_BREAK_RE.lastIndex = 0;
    while ((match = SENTENCE_BREAK_RE.exec(unspoken))) {
      lastBreak = match.index + match[0].length;
    }

    if (lastBreak > 0) {
      const sentence = unspoken.slice(0, lastBreak).trim();
      if (sentence) {
        enqueueRef.current(stripRef.current ? stripMarkdownForSpeech(sentence) : sentence);
      }
      spokenUpToRef.current += lastBreak;
    }

    lastRawRef.current = raw;
  }, [streamingContent, active]);

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
          enqueueRef.current(stripRef.current ? stripMarkdownForSpeech(remainder) : remainder);
        }
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isPlaying };
}
