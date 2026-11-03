/** A detector fed with 16 kHz mono Int16 frames of exactly `frameLength` samples. */
export interface WakeWordEngine {
  frameLength: number;
  process: (pcm: Int16Array) => void;
  /** Clears buffered audio/state, e.g. after a detection so the tail cannot trigger again. */
  reset: () => void;
  release: () => Promise<void>;
}
