import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodewhisper } from "nodejs-whisper";
import { BaseSpeechToTextProvider, type SpeechToTextProviderOptions } from "./speech-to-text-base.js";

interface NodejsWhisperSpeechToTextProviderOptions extends SpeechToTextProviderOptions {
  modelName?: string;
  modelRootPath?: string;
  autoDownloadModel?: boolean;
  withCuda?: boolean;
  timeoutMs?: number;
}

function parseBoolean(input: string | undefined, fallback = false): boolean {
  const normalized = (input ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function ensureWindowsCmakeInPath(): void {
  if (process.platform !== "win32") return;

  const cmakeBin = "C:\\Program Files\\CMake\\bin";
  const cmakeExe = join(cmakeBin, "cmake.exe");
  if (!existsSync(cmakeExe)) return;

  const currentPath = process.env["PATH"] ?? "";
  if (currentPath.toLowerCase().includes(cmakeBin.toLowerCase())) return;

  process.env["PATH"] = currentPath ? `${cmakeBin};${currentPath}` : cmakeBin;
}

export class NodejsWhisperSpeechToTextProvider extends BaseSpeechToTextProvider {
  readonly name = "nodejs-whisper";
  private readonly whisperOptions: NodejsWhisperSpeechToTextProviderOptions;

  constructor(options: NodejsWhisperSpeechToTextProviderOptions) {
    super(options);
    this.whisperOptions = options;
  }

  async transcribe(audioBuffer: Buffer, options?: { language?: string }): Promise<string> {
    ensureWindowsCmakeInPath();

    const timeoutMs = this.whisperOptions.timeoutMs ?? Number.parseInt(process.env["NODEJS_WHISPER_TIMEOUT_MS"] ?? "180000", 10);
    const modelName =
      this.whisperOptions.modelName ??
      process.env["NODEJS_WHISPER_MODEL_NAME"]?.trim() ??
      this.options.model?.trim() ??
      "base";
    const modelRootPath =
      this.whisperOptions.modelRootPath ??
      process.env["NODEJS_WHISPER_MODEL_ROOT_PATH"]?.trim() ??
      undefined;
    const autoDownloadModel =
      this.whisperOptions.autoDownloadModel ??
      parseBoolean(process.env["NODEJS_WHISPER_AUTO_DOWNLOAD"], true);
    const withCuda =
      this.whisperOptions.withCuda ??
      parseBoolean(process.env["NODEJS_WHISPER_USE_CUDA"], false);
    const language =
      options?.language?.trim() ||
      process.env["NODEJS_WHISPER_LANGUAGE"]?.trim() ||
      "auto";

    const tempDir = await mkdtemp(join(tmpdir(), "ducki-nodejs-whisper-"));
    const inputExt = (process.env["NODEJS_WHISPER_INPUT_EXT"] ?? process.env["LOCAL_STT_INPUT_EXT"] ?? "ogg").trim().replace(/^\.+/, "") || "ogg";
    const inputPath = join(tempDir, `input.${inputExt}`);
    await writeFile(inputPath, audioBuffer);

    try {
      const runPromise = nodewhisper(inputPath, {
        modelName,
        modelRootPath,
        autoDownloadModelName: autoDownloadModel ? modelName : undefined,
        withCuda,
        removeWavFileAfterTranscription: true,
        whisperOptions: {
          language,
        },
      }) as Promise<string>;

      const transcript = await Promise.race<string>([
        runPromise,
        new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error(`nodejs-whisper timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);

      const cleaned = transcript.trim();
      if (!cleaned) {
        throw new Error("nodejs-whisper returned empty transcript");
      }
      return cleaned;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
