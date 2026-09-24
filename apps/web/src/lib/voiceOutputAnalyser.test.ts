import { expect, it } from "vitest";
import { readVoiceOutput, registerVoiceOutput } from "./voiceOutputAnalyser";

function source(amplitude: number, frequency: number) {
  return {
    getByteTimeDomainData: (data: Uint8Array) => data.fill(128 + amplitude),
    getByteFrequencyData: (data: Uint8Array) => data.fill(frequency),
  } as unknown as AnalyserNode;
}
it("uses audible output when a newer streaming player is still silent", () => {
  const releaseAudible = registerVoiceOutput(source(30, 190));
  const releaseWaiting = registerVoiceOutput(source(0, 0));
  const wave = new Uint8Array(1024), spectrum = new Uint8Array(512);
  try {
    expect(readVoiceOutput(wave, spectrum)).toBe(true);
    expect(wave[0]).toBe(158);
    expect(spectrum[0]).toBe(190);
  } finally { releaseAudible(); releaseWaiting(); }
  expect(readVoiceOutput(wave, spectrum)).toBe(false);
  expect(wave.every((sample) => sample === 128)).toBe(true);
  expect(spectrum.every((sample) => sample === 0)).toBe(true);
});
