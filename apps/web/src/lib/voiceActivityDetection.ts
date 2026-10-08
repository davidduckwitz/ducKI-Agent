/**
 * Lightweight RMS-energy voice activity detector for the "automatic" recording mode -
 * watches a live MediaStream and calls back once the user has spoken for at least
 * `minSpeechMs` and then gone quiet for `silenceTimeoutMs`, so recording can stop itself
 * instead of waiting for a manual click or the fixed max-duration timer.
 *
 * Plain function, not a hook: ChatComposer's mic handling is already fully imperative
 * (MediaRecorder built and driven inside an event handler, not tied to render), so this
 * matches that style rather than forcing a parallel React lifecycle onto the same stream.
 */
export interface VoiceActivityWatcherOptions {
  /** RMS amplitude (0-1) above which the signal counts as "speech". */
  silenceThreshold: number;
  /** How long the signal must stay below the threshold, after having spoken, to stop. */
  silenceTimeoutMs: number;
  /** Minimum cumulative speech duration before silence is allowed to trigger a stop -
   *  guards against a single click/cough immediately ending the recording. */
  minSpeechMs: number;
  onSilenceStop: () => void;
  onSpeechStart?: () => void;
}

export interface VoiceActivityWatcherHandle {
  stop: () => void;
}

type AudioContextCtor = typeof AudioContext;
function audioContextCtor(): AudioContextCtor | undefined {
  return window.AudioContext || (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
}

// iOS/iPadOS Safari only lets an AudioContext leave "suspended" when resume() runs inside a user
// gesture. Contexts created later (after the awaited getUserMedia, or on the hands-free restart
// timer) stay silent forever, so the analyser reads 0 and VAD never hears speech. One shared
// context is therefore created + resumed from the tap and reused for every recording.
let sharedContext: AudioContext | null = null;

/** Call synchronously from a click/tap handler, before any `await`. */
export function unlockVoiceAudio(): void {
  const Ctor = audioContextCtor();
  if (!Ctor) return;
  try {
    if (!sharedContext || sharedContext.state === "closed") sharedContext = new Ctor();
    if (sharedContext.state === "suspended") void sharedContext.resume().catch(() => {});
  } catch {
    sharedContext = null;
  }
}

export function startVoiceActivityWatcher(
  stream: MediaStream,
  options: VoiceActivityWatcherOptions
): VoiceActivityWatcherHandle {
  const AudioContextCtor = audioContextCtor();
  if (!AudioContextCtor) {
    // No Web Audio API - the caller's max-duration timer remains the only stop condition.
    return { stop: () => {} };
  }

  const audioContext = sharedContext && sharedContext.state !== "closed" ? sharedContext : new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);

  let speechMs = 0;
  let previousAt = Date.now();
  let notified = false;
  void audioContext.resume().catch(() => {});
  let lastLoudAt = Date.now();
  let rafId = 0;
  let stopped = false;

  const teardown = () => {
    if (rafId) cancelAnimationFrame(rafId);
    try {
      source.disconnect();
    } catch {
      // Already disconnected - nothing to do.
    }
    // The shared context stays open so it keeps its gesture-granted "running" state.
    if (audioContext !== sharedContext) void audioContext.close().catch(() => {});
  };

  const tick = () => {
    if (stopped) return;

    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const normalized = ((data[i] ?? 128) - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / data.length);

    const now = Date.now();
    const elapsed = Math.min(now - previousAt, 100);
    previousAt = now;
    if (rms > options.silenceThreshold) {
      lastLoudAt = now;
      speechMs += elapsed;
    } else if (!notified && now - lastLoudAt > 150) {
      speechMs = 0;
    }

    const spokeLongEnough = speechMs >= options.minSpeechMs;
    if (spokeLongEnough && !notified) {
      notified = true;
      options.onSpeechStart?.();
    }
    const silentFor = now - lastLoudAt;

    if (spokeLongEnough && silentFor >= options.silenceTimeoutMs) {
      stopped = true;
      teardown();
      options.onSilenceStop();
      return;
    }

    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      teardown();
    },
  };
}
