/**
 * Every VoicePlayback/StreamingRow instance owns its own useSpeechSynthesis() hook (its own
 * queue, its own `stop`), so there is no single place that knows "is anything talking right
 * now" or can stop all of it at once - which is exactly what a display-level "stop reading"
 * control needs, especially for a long auto-played message the user wants to cut off
 * immediately. This is that shared place: instances register their `stop` while actually
 * playing, and a UI control can call stopAllPlayback() without knowing which instance(s) are
 * active.
 */
type StopFn = () => void;

const activeStoppers = new Map<number, StopFn>();
const listeners = new Set<() => void>();
let nextId = 1;

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function registerActivePlayback(stop: StopFn): () => void {
  const id = nextId++;
  activeStoppers.set(id, stop);
  notify();
  return () => {
    activeStoppers.delete(id);
    notify();
  };
}

export function stopAllPlayback(): void {
  activeStoppers.forEach((stop) => stop());
}

export function isPlaybackActive(): boolean {
  return activeStoppers.size > 0;
}

export function subscribePlaybackActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
