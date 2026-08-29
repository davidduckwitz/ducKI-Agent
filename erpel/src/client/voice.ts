/**
 * Voice helpers for Erpel's hands-free flow: strips markdown before TTS so the browser
 * doesn't read out literal "**"/"#"/code fences, and a small RMS-energy voice activity
 * watcher that stops a recording once the user has spoken and then gone quiet, instead of
 * requiring a second tap. Both are plain functions (no React) so they work the same way
 * whether called from an effect or a plain event handler.
 */

export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " Code-Block. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface VoiceActivityWatcherOptions {
  /** RMS amplitude (0-1) above which the signal counts as "speech". */
  silenceThreshold: number;
  /** How long the signal must stay below the threshold, after having spoken, to stop. */
  silenceTimeoutMs: number;
  /** Minimum cumulative speech duration before silence is allowed to trigger a stop. */
  minSpeechMs: number;
  /** Fired every animation frame with the current RMS level (0-1) - drive UI meters with it
   *  directly instead of routing it through React state (avoids a 60fps re-render churn). */
  onLevel?: (level: number) => void;
  onSilenceStop: () => void;
}

export interface VoiceActivityWatcherHandle {
  stop: () => void;
}

export function startVoiceActivityWatcher(
  stream: MediaStream,
  options: VoiceActivityWatcherOptions
): VoiceActivityWatcherHandle {
  const AudioContextCtor =
    window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
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
      // Already disconnected.
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
    options.onLevel?.(rms);

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
