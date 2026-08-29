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
}

export interface VoiceActivityWatcherHandle {
  stop: () => void;
}

export function startVoiceActivityWatcher(
  stream: MediaStream,
  options: VoiceActivityWatcherOptions
): VoiceActivityWatcherHandle {
  const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    // No Web Audio API - the caller's max-duration timer remains the only stop condition.
    return { stop: () => {} };
  }

  const audioContext = new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);

  let speechStartedAt: number | null = null;
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
    void audioContext.close().catch(() => {});
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
    if (rms > options.silenceThreshold) {
      lastLoudAt = now;
      if (speechStartedAt === null) speechStartedAt = now;
    }

    const spokeLongEnough = speechStartedAt !== null && lastLoudAt - speechStartedAt >= options.minSpeechMs;
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
