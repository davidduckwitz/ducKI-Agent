/**
 * Cross-component coordination for mic capture, mirroring voiceConversationBus.ts's pattern:
 * ChatComposer owns the actual getUserMedia/MediaRecorder lifecycle (see handleVoiceToggle),
 * the Audio tab's own big mic button just needs to trigger/observe it without prop-drilling
 * through ChatContainer or duplicating the capture logic.
 */
type ToggleListener = () => void;
type StreamListener = (stream: MediaStream) => void;
type StopListener = () => void;

const toggleListeners = new Set<ToggleListener>();
const streamStartedListeners = new Set<StreamListener>();
const streamStoppedListeners = new Set<StopListener>();
const endListeners = new Set<StopListener>();
const interruptListeners = new Set<StopListener>();

export function requestVoiceEnd(): void {
  for (const listener of endListeners) listener();
}

export function onVoiceEndRequested(listener: StopListener): () => void {
  endListeners.add(listener);
  return () => endListeners.delete(listener);
}

export function interruptVoiceReply(): void {
  for (const listener of interruptListeners) listener();
}

export function onVoiceReplyInterrupted(listener: StopListener): () => void {
  interruptListeners.add(listener);
  return () => interruptListeners.delete(listener);
}

/** Called by a UI control (e.g. AudioWorkspace's mic button) to start/stop ChatComposer's capture. */
export function requestVoiceToggle(): void {
  for (const listener of toggleListeners) listener();
}

/** Subscribed by ChatComposer to react to external toggle requests. */
export function onVoiceToggleRequested(listener: ToggleListener): () => void {
  toggleListeners.add(listener);
  return () => toggleListeners.delete(listener);
}

/** Called by ChatComposer right after getUserMedia succeeds, so visualizers can reuse the stream. */
export function emitVoiceCaptureStarted(stream: MediaStream): void {
  for (const listener of streamStartedListeners) listener(stream);
}

export function emitVoiceCaptureStopped(): void {
  for (const listener of streamStoppedListeners) listener();
}

export function onVoiceCaptureStarted(listener: StreamListener): () => void {
  streamStartedListeners.add(listener);
  return () => streamStartedListeners.delete(listener);
}

export function onVoiceCaptureStopped(listener: StopListener): () => void {
  streamStoppedListeners.add(listener);
  return () => streamStoppedListeners.delete(listener);
}
