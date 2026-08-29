import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseTextToSpeechProvider, type TextToSpeechProviderOptions } from "./text-to-speech-base.js";
import type { TextToSpeechResult, TextToSpeechSynthesizeOptions } from "@ducki/shared";
import { runTtsProcess } from "./local-process-tts-utils.js";

export interface PiperTextToSpeechProviderOptions extends TextToSpeechProviderOptions {
  executablePath?: string;
  modelPath?: string;
  lengthScale?: number;
  noiseScale?: number;
  noiseW?: number;
  sentenceSilence?: number;
  speakerId?: number;
  timeoutMs?: number;
}

/**
 * Guided Piper (https://github.com/rhasspy/piper) integration - fully local, no cloud call,
 * no auto-download of the binary/voice (see Phase 6 plan: platform-specific downloads with
 * their own failure modes are exactly what caused the whisper.cpp/CUDA build incident this
 * session already had to untangle once). Builds Piper's CLI invocation from structured,
 * individually-settable options instead of a raw command template, so the settings UI can
 * expose real sliders (speed, expressiveness) instead of a single opaque args string.
 */
export class PiperTextToSpeechProvider extends BaseTextToSpeechProvider {
  readonly name = "piper";
  private readonly piperOptions: PiperTextToSpeechProviderOptions;

  constructor(options: PiperTextToSpeechProviderOptions) {
    super(options);
    this.piperOptions = options;
  }

  async synthesize(text: string, options?: TextToSpeechSynthesizeOptions): Promise<TextToSpeechResult> {
    const executablePath = (this.piperOptions.executablePath ?? process.env["PIPER_EXECUTABLE_PATH"] ?? "piper").trim();
    const modelPath = (this.piperOptions.modelPath ?? process.env["PIPER_MODEL_PATH"] ?? "").trim();
    if (!modelPath) {
      throw new Error(
        "Piper voice model not configured. Set PIPER_MODEL_PATH to a downloaded .onnx voice " +
          "(e.g. from https://huggingface.co/rhasspy/piper-voices) and PIPER_EXECUTABLE_PATH if 'piper' isn't on PATH."
      );
    }

    const lengthScale = this.piperOptions.lengthScale ?? Number.parseFloat(process.env["PIPER_LENGTH_SCALE"] ?? "1");
    const noiseScale = this.piperOptions.noiseScale ?? Number.parseFloat(process.env["PIPER_NOISE_SCALE"] ?? "0.667");
    const noiseW = this.piperOptions.noiseW ?? Number.parseFloat(process.env["PIPER_NOISE_W"] ?? "0.8");
    const sentenceSilence = this.piperOptions.sentenceSilence ?? Number.parseFloat(process.env["PIPER_SENTENCE_SILENCE"] ?? "0.2");
    const speakerId = this.piperOptions.speakerId ?? (process.env["PIPER_SPEAKER_ID"] ? Number.parseInt(process.env["PIPER_SPEAKER_ID"], 10) : undefined);
    const timeoutMs = this.piperOptions.timeoutMs ?? Number.parseInt(process.env["PIPER_TIMEOUT_MS"] ?? "60000", 10);
    void options; // Piper has no per-request emotion-style knob - tuning is the settings above.

    const tempDir = await mkdtemp(join(tmpdir(), "ducki-piper-"));
    const outputPath = join(tempDir, "output.wav");

    const args = [
      "--model",
      modelPath,
      "--output_file",
      outputPath,
      "--length_scale",
      String(lengthScale),
      "--noise_scale",
      String(noiseScale),
      "--noise_w",
      String(noiseW),
      "--sentence_silence",
      String(sentenceSilence),
    ];
    if (speakerId !== undefined && Number.isFinite(speakerId)) {
      args.push("--speaker", String(speakerId));
    }

    try {
      const run = await runTtsProcess(executablePath, args, undefined, timeoutMs, text);
      if (run.exitCode !== 0) {
        throw new Error(`Piper failed with exit code ${run.exitCode}${run.stderr.trim() ? `: ${run.stderr.trim()}` : ""}`);
      }

      const audio = await readFile(outputPath);
      if (audio.length === 0) {
        throw new Error("Piper produced an empty audio file");
      }
      return { audio, mimeType: "audio/wav" };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
