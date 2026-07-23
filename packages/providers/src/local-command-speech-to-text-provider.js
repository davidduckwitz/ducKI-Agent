import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { BaseSpeechToTextProvider } from "./speech-to-text-base.js";
function parseArgsTemplate(template) {
    const trimmed = template.trim();
    if (!trimmed)
        return ["{input}"];
    const jsonCandidate = trimmed.startsWith("[") ? trimmed : "";
    if (jsonCandidate) {
        try {
            const parsed = JSON.parse(jsonCandidate);
            if (Array.isArray(parsed)) {
                return parsed.map((part) => String(part));
            }
        }
        catch {
            // Fall back to shell-like tokenization below.
        }
    }
    return trimmed.split(/\s+/).filter((part) => part.length > 0);
}
function replacePlaceholders(args, values) {
    return args.map((arg) => {
        let next = arg;
        for (const [key, value] of Object.entries(values)) {
            next = next.replaceAll(`{${key}}`, value);
        }
        return next;
    });
}
function runLocalProcess(command, args, cwd, timeoutMs) {
    return new Promise((resolveResult, rejectResult) => {
        const child = spawn(command, args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            shell: false,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        const timeout = setTimeout(() => {
            child.kill("SIGTERM");
            rejectResult(new Error(`Local STT process timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.on("error", (error) => {
            clearTimeout(timeout);
            rejectResult(error);
        });
        child.on("close", (code) => {
            clearTimeout(timeout);
            resolveResult({ stdout, stderr, exitCode: code ?? 0 });
        });
    });
}
export class LocalCommandSpeechToTextProvider extends BaseSpeechToTextProvider {
    name = "local";
    localOptions;
    constructor(options) {
        super(options);
        this.localOptions = options;
    }
    async transcribe(audioBuffer, options) {
        const command = (this.localOptions.command ?? process.env["LOCAL_STT_COMMAND"] ?? this.localOptions.baseUrl ?? "").trim();
        if (!command) {
            throw new Error("Local STT command not configured. Set LOCAL_STT_COMMAND (for example whisper-cli) and LOCAL_STT_ARGS (for example '-f {input}')");
        }
        const argsTemplate = this.localOptions.args ??
            parseArgsTemplate(process.env["LOCAL_STT_ARGS"] ??
                this.localOptions.model ??
                "{input}");
        const timeoutMs = this.localOptions.timeoutMs ?? Number.parseInt(process.env["LOCAL_STT_TIMEOUT_MS"] ?? "120000", 10);
        const workingDirectory = this.localOptions.workingDirectory ?? process.env["LOCAL_STT_WORKDIR"];
        const tempDir = await mkdtemp(join(tmpdir(), "ducki-local-stt-"));
        const inputExtension = (process.env["LOCAL_STT_INPUT_EXT"] ?? "bin").trim().replace(/^\.+/, "") || "bin";
        const inputPath = join(tempDir, `input-audio.${inputExtension}`);
        const outputBasePath = join(tempDir, "transcript");
        const outputPath = `${outputBasePath}.txt`;
        await writeFile(inputPath, audioBuffer);
        try {
            const args = replacePlaceholders(argsTemplate, {
                input: inputPath,
                output: outputPath,
                outputBase: outputBasePath,
                language: options?.language ?? "",
                inputName: basename(inputPath),
                outputName: basename(outputPath),
            });
            const run = await runLocalProcess(command, args, workingDirectory ? resolve(workingDirectory) : undefined, timeoutMs);
            if (run.exitCode !== 0) {
                throw new Error(`Local STT command failed with exit code ${run.exitCode}${run.stderr.trim() ? `: ${run.stderr.trim()}` : ""}`);
            }
            const usesOutputFile = argsTemplate.some((arg) => arg.includes("{output}") || arg.includes("{outputBase}"));
            let transcript = run.stdout.trim();
            if (usesOutputFile || !transcript) {
                const fileCandidates = [
                    outputPath,
                    `${outputBasePath}.txt`,
                    outputBasePath,
                ];
                for (const candidate of fileCandidates) {
                    try {
                        const fromFile = (await readFile(candidate, "utf8")).trim();
                        if (fromFile) {
                            transcript = fromFile;
                            break;
                        }
                    }
                    catch {
                        // Ignore missing output candidates and continue fallback chain.
                    }
                }
            }
            if (!transcript) {
                throw new Error("Local STT command returned empty transcript");
            }
            return transcript;
        }
        finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    }
}
//# sourceMappingURL=local-command-speech-to-text-provider.js.map