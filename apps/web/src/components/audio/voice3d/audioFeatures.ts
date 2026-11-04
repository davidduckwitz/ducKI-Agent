import { createAudioLevelAnalyser, type AudioLevelAnalyserHandle } from "../../../lib/audioLevelAnalyser";
import { onVoiceCaptureStarted, onVoiceCaptureStopped } from "../../../lib/voiceCaptureBus";
import { isPlaybackActive } from "../../../lib/voicePlaybackRegistry";
import { readVoiceOutput } from "../../../lib/voiceOutputAnalyser";
import { useAppStore } from "../../../lib/store";

export type VoiceOrbStatus = "idle" | "listening" | "thinking" | "speaking" | "user-speaking";

export const WAVE_SIZE = 1024;
export const SPECTRUM_SIZE = 512;
export const HISTORY_LENGTH = 3;
export const ECHO_LENGTH = 80;

const rms = (data: Uint8Array) => {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += ((data[i]! - 128) / 128) ** 2;
  return Math.sqrt(sum / data.length);
};

/**
 * Audio analysis shared by every voice visual (GPU orb, 2D fallback, wiki backdrop).
 * Sampling stays outside React; only semantic status changes reach `onStatus`.
 * `wave`/`spectrum` follow whoever is talking, `outputEnergy`/`outputOnset` only
 * the agent - the backdrop's synapse discharges react to the agent's voice alone.
 */
export class VoiceAudioFeatures {
  readonly input = new Uint8Array(WAVE_SIZE).fill(128);
  readonly output = new Uint8Array(WAVE_SIZE).fill(128);
  readonly inputSpectrum = new Uint8Array(SPECTRUM_SIZE);
  readonly outputSpectrum = new Uint8Array(SPECTRUM_SIZE);
  /** Oldest to newest after `update()`. */
  readonly inputHistory = Array.from({ length: HISTORY_LENGTH }, () => new Uint8Array(WAVE_SIZE).fill(128));
  readonly outputHistory = Array.from({ length: HISTORY_LENGTH }, () => new Uint8Array(WAVE_SIZE).fill(128));
  /** Energy echo ring, oldest first after `update()`. */
  readonly echoes = new Float32Array(ECHO_LENGTH);
  wave: Uint8Array = this.output;
  spectrum: Uint8Array = this.outputSpectrum;
  status: VoiceOrbStatus = "idle";
  energy = 0;
  bass = 0;
  mids = 0;
  highs = 0;
  inputLevel = 0;
  outputLevel = 0;
  outputEnergy = 0;
  /** True for the single frame in which an agent syllable starts. */
  outputOnset = false;
  measuredOutput = false;

  private microphone: AudioLevelAnalyserHandle | null = null;
  private lastSpeech = -1000;
  private echoRing = new Float32Array(ECHO_LENGTH);
  private echoIndex = 0;
  private slowOutput = 0;
  private lastOnset = 0;
  private readonly cleanup: Array<() => void>;

  constructor(private readonly onStatus: (status: VoiceOrbStatus) => void) {
    this.cleanup = [
      onVoiceCaptureStarted((stream) => {
        this.microphone?.stop();
        this.microphone = createAudioLevelAnalyser(stream);
      }),
      onVoiceCaptureStopped(() => { this.microphone?.stop(); this.microphone = null; }),
    ];
  }

  update(now: number): void {
    const microphone = this.microphone;
    microphone?.read(this.input, this.inputSpectrum);
    if (!microphone) { this.input.fill(128); this.inputSpectrum.fill(0); }
    this.measuredOutput = readVoiceOutput(this.output, this.outputSpectrum);
    for (const [history, latest] of [[this.inputHistory, this.input], [this.outputHistory, this.output]] as const) {
      const oldest = history.shift()!;
      oldest.set(latest);
      history.push(oldest);
    }
    this.inputLevel = rms(this.input);
    this.outputLevel = rms(this.output);
    if (this.inputLevel > 0.025) this.lastSpeech = now;
    const speaking = isPlaybackActive();
    const next: VoiceOrbStatus = microphone && now - this.lastSpeech < 240 ? "user-speaking"
      : speaking ? "speaking" : useAppStore.getState().isLoading ? "thinking"
      : microphone ? "listening" : "idle";
    if (next !== this.status) { this.status = next; this.onStatus(next); }

    const user = next === "user-speaking";
    this.wave = user ? this.input : this.output;
    this.spectrum = user ? this.inputSpectrum : this.outputSpectrum;
    const target = Math.min(1, (user ? this.inputLevel : this.outputLevel) * 6);
    this.energy += (target - this.energy) * (target > this.energy ? 0.5 : 0.12);
    const bandEnergy = (from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += this.spectrum[i]! / 255;
      return sum / (to - from);
    };
    this.bass += (bandEnergy(1, 8) - this.bass) * 0.3;
    this.mids += (bandEnergy(8, 70) - this.mids) * 0.4;
    this.highs += (bandEnergy(70, 230) - this.highs) * 0.5;
    this.echoRing[this.echoIndex] = this.energy;
    this.echoIndex = (this.echoIndex + 1) % ECHO_LENGTH;
    for (let i = 0; i < ECHO_LENGTH; i++) this.echoes[i] = this.echoRing[(this.echoIndex + i) % ECHO_LENGTH]!;

    // Agent-only energy plus a simple onset detector: a fast follower jumping clearly
    // above a slow one marks the start of a syllable (rate-limited to ~11 Hz).
    const agent = speaking ? Math.min(1, this.outputLevel * 6) : 0;
    const previous = this.outputEnergy;
    this.outputEnergy += (agent - this.outputEnergy) * (agent > this.outputEnergy ? 0.55 : 0.1);
    this.slowOutput += (agent - this.slowOutput) * 0.04;
    this.outputOnset = speaking && this.outputEnergy > 0.12 && this.outputEnergy - this.slowOutput > 0.12
      && this.outputEnergy > previous && now - this.lastOnset > 90;
    if (this.outputOnset) this.lastOnset = now;
  }

  dispose(): void {
    for (const off of this.cleanup) off();
    this.microphone?.stop();
    this.microphone = null;
  }
}
