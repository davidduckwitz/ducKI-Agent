/**
 * Imperative RMS-level reader for a live MediaStream, used by VoiceOrb.tsx to drive its
 * mic-reactive animation via requestAnimationFrame rather than a React re-render per frame.
 */
export interface AudioLevelAnalyserHandle {
  read: (wave: Uint8Array, spectrum: Uint8Array) => void;
  /** Current RMS amplitude, 0-1. */
  getLevel: () => number;
  stop: () => void;
}

export function createAudioLevelAnalyser(stream: MediaStream): AudioLevelAnalyserHandle {
  const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return { read: (wave, spectrum) => { wave.fill(128); spectrum.fill(0); }, getLevel: () => 0, stop: () => {} };
  }

  const audioContext = new AudioContextCtor();
  void audioContext.resume().catch(() => {});
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  let stopped = false;

  return {
    read: (wave, spectrum) => {
      if (stopped) { wave.fill(128); spectrum.fill(0); return; }
      analyser.getByteTimeDomainData(wave as Uint8Array<ArrayBuffer>);
      analyser.getByteFrequencyData(spectrum as Uint8Array<ArrayBuffer>);
    },
    getLevel: () => {
      if (stopped) return 0;
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const normalized = ((data[i] ?? 128) - 128) / 128;
        sumSquares += normalized * normalized;
      }
      return Math.sqrt(sumSquares / data.length);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        source.disconnect();
      } catch {
        // Already disconnected - nothing to do.
      }
      void audioContext.close().catch(() => {});
    },
  };
}
