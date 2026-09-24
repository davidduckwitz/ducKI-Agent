import { spawn, execFile } from "node:child_process";
interface WhisperProcessOptions {
  modelName: string;
  modelRootPath?: string;
  autoDownloadModelName?: string;
  withCuda?: boolean;
  removeWavFileAfterTranscription?: boolean;
  whisperOptions?: { language?: string };
}

// nodejs-whisper uses shelljs.cd(), which changes cwd for the entire Node process.
// Keep its imports, model downloads and native subprocesses out of the server process.
const WORKER = `
process.once('message', async ({ inputPath, options }) => {
  let result;
  try {
    const { nodewhisper } = require(process.argv[1]);
    const transcript = await nodewhisper(inputPath, options);
    result = { transcript };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  process.send(result, () => process.exit(result.error ? 1 : 0));
});
`;

export function runWhisperProcess(
  modulePath: string,
  inputPath: string,
  options: WhisperProcessOptions,
  timeoutMs: number,
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return Promise.reject(new Error("Invalid nodejs-whisper timeout"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", WORKER, modulePath], {
      windowsHide: true,
      // A POSIX process group lets a timeout terminate ffmpeg/whisper too.
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let transcript: string | undefined;
    let failure: Error | undefined;
    let stderr = "";
    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
          if (error) child.kill();
        });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timeout = setTimeout(() => {
      failure = new Error(`nodejs-whisper timed out after ${timeoutMs}ms`);
      terminate();
    }, timeoutMs);
    child.stderr?.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4096); });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const result = message as { transcript?: unknown; error?: unknown };
      if (typeof result.error === "string") failure ??= new Error(result.error);
      if (typeof result.transcript === "string") transcript = result.transcript;
    });
    child.once("error", (error) => { failure ??= error; });
    // Wait for close, not just an IPC response: the caller removes temporary audio next.
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (code !== 0 || transcript === undefined) reject(new Error(`Whisper process exited (${code}): ${stderr || "no transcript"}`));
      else resolve(transcript);
    });
    child.send({ inputPath, options }, (error) => {
      if (error) { failure ??= error; terminate(); }
    });
  });
}
