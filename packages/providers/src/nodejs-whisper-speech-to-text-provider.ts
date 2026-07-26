import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/** Where nodejs-whisper looks for the compiled CLI, mirroring its own WhisperHelper. */
const WHISPER_CLI_CANDIDATES = [
  join("build", "bin", "Release", "whisper-cli.exe"),
  join("build", "bin", "Debug", "whisper-cli.exe"),
  join("build", "bin", "whisper-cli.exe"),
  join("build", "bin", "whisper-cli"),
  join("build", "whisper-cli"),
];

/**
 * Resolves the whisper.cpp checkout inside the installed nodejs-whisper package.
 * Returns undefined if the package cannot be located at all.
 */
function findWhisperCppPath(): string | undefined {
  try {
    // The package's entry point is <pkg>/dist/index.js, so cpp/whisper.cpp sits two
    // levels up from it.
    const entry = createRequire(import.meta.url).resolve("nodejs-whisper");
    return join(dirname(dirname(entry)), "cpp", "whisper.cpp");
  } catch {
    return undefined;
  }
}

export class NodejsWhisperSpeechToTextProvider extends BaseSpeechToTextProvider {
  readonly name = "nodejs-whisper";
  private readonly whisperOptions: NodejsWhisperSpeechToTextProviderOptions;

  constructor(options: NodejsWhisperSpeechToTextProviderOptions) {
    super(options);
    this.whisperOptions = options;
  }

  /**
   * Fails early and legibly when whisper.cpp was never compiled.
   *
   * nodejs-whisper only builds whisper.cpp as a side effect of *downloading* a model: if
   * the model file already exists it returns early and skips the build entirely. So once
   * the build directory is gone (a clean, a reinstall) while the model file remains, the
   * library can never rebuild itself - it just reports "whisper-cli executable not found"
   * from deep inside a transcription attempt, which the gateway then swallowed into a
   * console.warn. Checking up front lets us name the actual remedy instead.
   */
  private assertWhisperCliAvailable(): void {
    const whisperCppPath = findWhisperCppPath();
    if (!whisperCppPath || !existsSync(whisperCppPath)) {
      throw new Error(
        "nodejs-whisper ist nicht installiert (cpp/whisper.cpp fehlt). Fuehre 'pnpm install' aus oder stelle DISCORD_VOICE_STT_PROVIDER auf 'openai' bzw. 'local' um."
      );
    }

    const found = WHISPER_CLI_CANDIDATES.some((candidate) => existsSync(join(whisperCppPath, candidate)));
    if (found) return;

    throw new Error(
      "whisper.cpp ist nicht kompiliert - die whisper-cli Binary fehlt. " +
        "Baue sie einmalig mit 'pnpm whisper:build' (benoetigt CMake und C++ Build Tools). " +
        "Hinweis: nodejs-whisper baut nur beim Modell-Download, und das Modell liegt bereits vor - " +
        "der Build wird deshalb nie automatisch nachgeholt. " +
        "Alternativ DISCORD_VOICE_STT_PROVIDER auf 'openai' oder 'local' setzen."
    );
  }

  async transcribe(audioBuffer: Buffer, options?: { language?: string }): Promise<string> {
    ensureWindowsCmakeInPath();
    this.assertWhisperCliAvailable();

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
