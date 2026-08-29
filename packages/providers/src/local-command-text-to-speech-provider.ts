import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BaseTextToSpeechProvider, type TextToSpeechProviderOptions } from "./text-to-speech-base.js";
import type { TextToSpeechResult, TextToSpeechSynthesizeOptions } from "@ducki/shared";
import { parseArgsTemplate, replacePlaceholders, runTtsProcess } from "./local-process-tts-utils.js";

interface LocalTextToSpeechProviderOptions extends TextToSpeechProviderOptions {
  command?: string;
  args?: string[];
  workingDirectory?: string;
  timeoutMs?: number;
  outputExt?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

/**
 * Escape hatch that works with ANY local TTS CLI, not just Piper - the same idea as the
 * existing `local` speech-to-text provider (LOCAL_STT_COMMAND), just for the opposite
 * direction. Text is written to a temp file (for engines that want a `{textFile}` argument)
 * AND piped on stdin (Piper's own interface), since local TTS tools vary in which they expect.
 */
export class LocalCommandTextToSpeechProvider extends BaseTextToSpeechProvider {
  readonly name = "local";
  private readonly localOptions: LocalTextToSpeechProviderOptions;

  constructor(options: LocalTextToSpeechProviderOptions) {
    super(options);
    this.localOptions = options;
  }

  async synthesize(text: string, _options?: TextToSpeechSynthesizeOptions): Promise<TextToSpeechResult> {
    const command = (this.localOptions.command ?? process.env["LOCAL_TTS_COMMAND"] ?? "").trim();
    if (!command) {
      throw new Error(
        "Local TTS command not configured. Set LOCAL_TTS_COMMAND (e.g. piper) and LOCAL_TTS_ARGS (e.g. '--model {model} --output_file {output}')"
      );
    }

    const argsTemplate = this.localOptions.args ?? parseArgsTemplate(process.env["LOCAL_TTS_ARGS"] ?? "--output_file {output}");
    const timeoutMs = this.localOptions.timeoutMs ?? Number.parseInt(process.env["LOCAL_TTS_TIMEOUT_MS"] ?? "60000", 10);
    const workingDirectory = this.localOptions.workingDirectory ?? process.env["LOCAL_TTS_WORKDIR"];
    const outputExt = (this.localOptions.outputExt ?? process.env["LOCAL_TTS_OUTPUT_EXT"] ?? "wav").trim().replace(/^\.+/, "") || "wav";

    const tempDir = await mkdtemp(join(tmpdir(), "ducki-local-tts-"));
    const textFilePath = join(tempDir, "input.txt");
    const outputPath = join(tempDir, `output.${outputExt}`);
    await writeFile(textFilePath, text, "utf8");

    try {
      const args = replacePlaceholders(argsTemplate, {
        textFile: textFilePath,
        output: outputPath,
        model: this.options.model ?? "",
        voice: this.options.voice ?? "",
      });

      const run = await runTtsProcess(command, args, workingDirectory ? resolve(workingDirectory) : undefined, timeoutMs, text);
      if (run.exitCode !== 0) {
        throw new Error(`Local TTS command failed with exit code ${run.exitCode}${run.stderr.trim() ? `: ${run.stderr.trim()}` : ""}`);
      }

      const audio = await readFile(outputPath);
      if (audio.length === 0) {
        throw new Error("Local TTS command produced an empty audio file");
      }
      return { audio, mimeType: MIME_BY_EXT[outputExt] ?? "application/octet-stream" };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
