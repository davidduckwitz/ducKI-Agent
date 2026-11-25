import { registerActivePlayback } from "./voicePlaybackRegistry";

/**
 * One shared, FIFO "speaker" for every TTS output in the app.
 *
 * Each VoicePlayback / StreamingRow owns its own useSpeechSynthesis() queue, and every streaming
 * block gets its own StreamingAudioPlayer (own AudioContext, own schedule). Nothing coordinated
 * them, so two of them could talk at the same time - e.g. the next block's realtime player
 * starting while the previous block's player was still draining (useStreamingSpeech calls end(),
 * not stop(), at a block boundary), VoicePlayback's streaming-fallback remainder playing on top of
 * the still-running stream, or several completed blocks of one turn auto-playing in parallel.
 *
 * A producer requests the lane before it makes any sound and releases it once it is done; only
 * the current holder plays, everyone else waits in request order. Synthesis/prefetch may still
 * run while waiting - only audible playback is serialized.
 *
 * Waiters are registered in voicePlaybackRegistry too, so stopAllPlayback() (mic barge-in, the
 * display-level stop control) also cancels speech that is queued but not yet audible.
 */
export interface SpeechLaneHandle {
  /** Gives the lane up (or leaves the wait list). Idempotent. */
  release: () => void;
}

interface Holder {
  id: number;
  onGrant: () => void;
  unregister: () => void;
}

let current: Holder | null = null;
const waiters: Holder[] = [];
let nextId = 1;

function grantNext(): void {
  while (!current && waiters.length) {
    const next = waiters.shift()!;
    current = next;
    try {
      next.onGrant();
    } catch {
      // A throwing holder must not wedge the lane for everyone else.
      if (current === next) {
        current = null;
        next.unregister();
      }
    }
  }
}

export function requestSpeechLane(onGrant: () => void, stop: () => void): SpeechLaneHandle {
  const holder: Holder = { id: nextId++, onGrant, unregister: () => {} };
  holder.unregister = registerActivePlayback(stop);
  waiters.push(holder);
  let released = false;
  // Granted synchronously when the lane is free, so a lone speaker has no added latency.
  grantNext();
  return {
    release: () => {
      if (released) return;
      released = true;
      holder.unregister();
      if (current === holder) {
        current = null;
        grantNext();
      } else {
        const index = waiters.indexOf(holder);
        if (index >= 0) waiters.splice(index, 1);
      }
    },
  };
}

/** Test helper. */
export function resetSpeechLaneForTests(): void {
  current = null;
  waiters.length = 0;
}
