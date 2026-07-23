import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodewhisper } from "nodejs-whisper";
import { BaseSpeechToTextProvider } from "./speech-to-text-base.js";
function parseBoolean(input, fallback = false) {
    const normalized = (input ?? "").trim().toLowerCase();
    if (!normalized)
        return fallback;
    if (["1", "true", "yes", "on"].includes(normalized))
        return true;
    if (["0", "false", "no", "off"].includes(normalized))
        return false;
    return fallback;
}
function ensureWindowsCmakeInPath() {
    if (process.platform !== "win32")
        return;
    const cmakeBin = "C:\\Program Files\\CMake\\bin";
    const cmakeExe = join(cmakeBin, "cmake.exe");
    if (!existsSync(cmakeExe))
        return;
    const currentPath = process.env["PATH"] ?? "";
    if (currentPath.toLowerCase().includes(cmakeBin.toLowerCase()))
        return;
    process.env["PATH"] = currentPath ? `${cmakeBin};${currentPath}` : cmakeBin;
}
export class NodejsWhisperSpeechToTextProvider extends BaseSpeechToTextProvider {
    name = "nodejs-whisper";
    whisperOptions;
    constructor(options) {
        super(options);
        this.whisperOptions = options;
    }
    async transcribe(audioBuffer, options) {
        ensureWindowsCmakeInPath();
        const timeoutMs = this.whisperOptions.timeoutMs ?? Number.parseInt(process.env["NODEJS_WHISPER_TIMEOUT_MS"] ?? "180000", 10);
        const modelName = this.whisperOptions.modelName ??
            process.env["NODEJS_WHISPER_MODEL_NAME"]?.trim() ??
            this.options.model?.trim() ??
            "base";
        const modelRootPath = this.whisperOptions.modelRootPath ??
            process.env["NODEJS_WHISPER_MODEL_ROOT_PATH"]?.trim() ??
            undefined;
        const autoDownloadModel = this.whisperOptions.autoDownloadModel ??
            parseBoolean(process.env["NODEJS_WHISPER_AUTO_DOWNLOAD"], true);
        const withCuda = this.whisperOptions.withCuda ??
            parseBoolean(process.env["NODEJS_WHISPER_USE_CUDA"], false);
        const language = options?.language?.trim() ||
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
            });
            const transcript = await Promise.race([
                runPromise,
                new Promise((_, reject) => {
                    setTimeout(() => reject(new Error(`nodejs-whisper timed out after ${timeoutMs}ms`)), timeoutMs);
                }),
            ]);
            const cleaned = transcript.trim();
            if (!cleaned) {
                throw new Error("nodejs-whisper returned empty transcript");
            }
            return cleaned;
        }
        finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    }
}
//# sourceMappingURL=nodejs-whisper-speech-to-text-provider.js.map