/**
 * Minimal pub/sub so the composer (which owns the mic) can react to "the agent just finished
 * speaking" without a prop-drilled callback - VoicePlayback/StreamingRow (deep in the message
 * list) and ChatComposer (a sibling) don't otherwise share a parent close enough for that.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onAgentTurnEnded(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitAgentTurnEnded(): void {
  listeners.forEach((listener) => listener());
}
