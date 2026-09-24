// Read audio at the actual output node, so queued text never animates as audible speech.
const analysers = new Set<AnalyserNode>();
const candidateWave = new Uint8Array(1024);
const candidateSpectrum = new Uint8Array(512);
export function registerVoiceOutput(analyser: AnalyserNode): () => void {
  analysers.add(analyser);
  return () => { analysers.delete(analyser); };
}
export function readVoiceOutput(wave: Uint8Array, spectrum: Uint8Array): boolean {
  wave.fill(128); spectrum.fill(0);
  let loudest = -1;
  for (const analyser of analysers) {
    analyser.getByteTimeDomainData(candidateWave);
    let energy = 0;
    for (const sample of candidateWave) energy += (sample - 128) ** 2;
    if (energy <= loudest) continue;
    loudest = energy;
    analyser.getByteFrequencyData(candidateSpectrum);
    wave.set(candidateWave.subarray(0, wave.length));
    spectrum.set(candidateSpectrum.subarray(0, spectrum.length));
  }
  return analysers.size > 0;
}

export function observeVoiceElement(audio: HTMLAudioElement): () => void {
  const context = new AudioContext();
  const source = context.createMediaElementSource(audio);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.75;
  source.connect(analyser);
  analyser.connect(context.destination);
  const unregister = registerVoiceOutput(analyser);
  void context.resume().catch(() => {});
  return () => {
    unregister();
    source.disconnect();
    analyser.disconnect();
    void context.close().catch(() => {});
  };
}
