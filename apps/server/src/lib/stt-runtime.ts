import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { DatabaseService } from "@ducki/database";
import { localChatterboxUrl } from "./chatterbox-runtime.js";
import { createVenv } from "./pocket-tts-runtime.js";
import { PYTHON_DATA_DIR, PYTHON_SCRIPTS_DIR as scripts, pythonServerEnv, venvPython } from "./python-paths.js";
import { run } from "./qwen-tts-runtime.js";
import { modelServerEnv } from "./secrets-store.js";

// Lifecycle of the local faster-whisper server (scripts/stt_server.py) - same model as
// chatterbox-runtime.ts: only a process we spawned ourselves is ever stopped.
// Shared with Chatterbox (same venv, see requirements-stt.txt).
const VENV_DIR = `${PYTHON_DATA_DIR}.venv`;
const REQUIREMENTS = `${scripts}requirements-stt.txt`;
export const DEFAULT_STT_SERVER_URL = "http://127.0.0.1:8891";
let child: ChildProcess | undefined;
let operation: Promise<unknown> | undefined;
let lastError: string | undefined;
let setupPhase: string | undefined;
let envCache: { ready: boolean; checkedAt: number } | undefined;
const intentionallyStopped = new WeakSet<ChildProcess>();

export async function sttServerUrl(db: DatabaseService): Promise<URL> {
  return localChatterboxUrl(await db.getSetting("STT_SERVER_URL") || DEFAULT_STT_SERVER_URL);
}

export async function sttServerStatus(db: DatabaseService) {
  const url = await sttServerUrl(db);
  let health: Record<string, unknown> | undefined;
  try {
    const response = await fetch(new URL("health", url), { signal: AbortSignal.timeout(2000) });
    if (response.ok) health = await response.json() as Record<string, unknown>;
  } catch { /* A stopped server is a normal status. */ }
  return { reachable: !!health, managed: !!child, working: !!operation, phase: setupPhase, error: lastError,
    envReady: health ? true : await sttEnvironmentReady(),
    autoStart: (await db.getSetting("STT_SERVER_AUTO_START")) !== "false", health };
}

function pythonPath(): string {
  const override = process.env["STT_PYTHON"] || process.env["CHATTERBOX_PYTHON"];
  if (override) return override;
  return existsSync(venvPython(VENV_DIR)) ? venvPython(VENV_DIR) : "python";
}

export function resetSttEnvironmentCache(): void { envCache = undefined; }

async function sttEnvironmentReady(force = false): Promise<boolean> {
  if (!force && envCache && Date.now() - envCache.checkedAt < 60_000) return envCache.ready;
  const ready = (await run(pythonPath(), ["-c", "import faster_whisper, flask, waitress"], { timeoutMs: 60_000 })).code === 0;
  envCache = { ready, checkedAt: Date.now() };
  return ready;
}

/** Creates .venv (if missing) and installs faster-whisper. Only on explicit user action. */
async function setupEnvironment() {
  const fail = (message: string, output: string): never => {
    throw new Error(`${message}\n${output.trim().split("\n").slice(-6).join("\n")}`);
  };
  try {
    const hasUv = (await run("uv", ["--version"], { timeoutMs: 10_000 })).code === 0;
    const python = venvPython(VENV_DIR);
    if (!existsSync(python)) {
      setupPhase = "Erstelle Python-Umgebung (.venv) …";
      const output = await createVenv(VENV_DIR, hasUv);
      if (output !== undefined) fail("Python-Umgebung konnte nicht erstellt werden. Installiere Python 3.10–3.14 (oder uv: https://docs.astral.sh/uv/).", output);
    }
    // Without torch in the venv, faster-whisper needs the CUDA libraries as pip packages.
    const cuda = (await run("nvidia-smi", [], { timeoutMs: 10_000 })).code === 0 ? ["nvidia-cublas-cu12", "nvidia-cudnn-cu12==9.*"] : [];
    setupPhase = cuda.length ? "Installiere faster-whisper (mit CUDA) …" : "Installiere faster-whisper …";
    const args = ["-r", REQUIREMENTS, ...cuda];
    const install = hasUv
      ? await run("uv", ["pip", "install", "--python", python, ...args], { timeoutMs: 3_600_000 })
      : await run(python, ["-m", "pip", "install", ...args], { timeoutMs: 3_600_000 });
    if (install.code !== 0) fail("Installation von faster-whisper fehlgeschlagen.", install.output);
    setupPhase = "Prüfe Installation …";
    if (!(await sttEnvironmentReady(true))) {
      fail("Installation abgeschlossen, aber faster_whisper ist nicht importierbar.", (await run(python, ["-c", "import faster_whisper"])).output);
    }
  } finally { setupPhase = undefined; }
}

async function modelRequest(db: DatabaseService, action: "load" | "unload") {
  // First load may download the model (large-v3-turbo ~1.6 GB).
  const response = await fetch(new URL(`model/${action}`, await sttServerUrl(db)), {
    method: "POST", signal: AbortSignal.timeout(900_000),
  });
  if (!response.ok) throw new Error(`STT-Server: ${await response.text()}`);
}

async function start(db: DatabaseService) {
  if ((await sttServerStatus(db)).reachable) return;
  const url = await sttServerUrl(db);
  if (!child) {
    if (!(await sttEnvironmentReady(true))) throw new Error("Python-Umgebung für faster-whisper fehlt – bitte zuerst „Umgebung einrichten“ wählen.");
    const python = pythonPath();
    const setting = async (key: string) => (await db.getSetting(key))?.trim() || undefined;
    const env: NodeJS.ProcessEnv = { ...process.env, ...pythonServerEnv(), ...(await modelServerEnv(db)), STT_HOST: "127.0.0.1", STT_PORT: url.port || "80", STT_LAZY_LOAD: "1" };
    const model = await setting("STT_SERVER_MODEL");
    const device = await setting("STT_SERVER_DEVICE");
    if (model) env["STT_MODEL"] = model;
    if (device) env["STT_DEVICE"] = device;
    const proc = spawn(python, [`${scripts}stt_server.py`], { cwd: scripts, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    child = proc;
    proc.stdout?.on("data", (data: Buffer) => console.info(`[STT] ${data.toString().trim()}`));
    proc.stderr?.on("data", (data: Buffer) => console.error(`[STT] ${data.toString().trim()}`));
    proc.on("error", (error) => { lastError = error.message; if (child === proc) child = undefined; });
    proc.on("exit", (code) => {
      if (child === proc) {
        child = undefined;
        if (code && !intentionallyStopped.has(proc)) lastError = `STT-Server beendet (Code ${code}). „Umgebung einrichten“ ausführen und Log prüfen.`;
      }
    });
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!child) throw new Error(lastError || "STT-Server konnte nicht gestartet werden.");
    if ((await sttServerStatus(db)).reachable) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stopSttServer();
  throw new Error("STT-Serverstart hat das Zeitlimit überschritten.");
}

export function stopSttServer() {
  if (!child?.pid) return;
  intentionallyStopped.add(child);
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
  } else {
    child.kill();
  }
}

export function controlSttServer(db: DatabaseService, action: "start" | "stop" | "load" | "unload" | "setup") {
  if (operation) throw new Error("Eine STT-Server-Aktion läuft bereits.");
  lastError = undefined;
  operation = (async () => {
    if (action === "stop") {
      if (!child) throw new Error("Dieser Server wurde extern gestartet. Bitte dort stoppen.");
      const proc = child;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Server konnte nicht gestoppt werden.")), 10_000);
        proc.once("exit", () => { clearTimeout(timer); resolve(); });
        try { stopSttServer(); } catch (error) { clearTimeout(timer); reject(error); }
      });
    } else if (action === "setup") {
      await setupEnvironment();
    } else if (action === "start") {
      await start(db);
      await modelRequest(db, "load");
    } else {
      await modelRequest(db, action);
    }
  })().catch((error: unknown) => {
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }).finally(() => { operation = undefined; });
  return operation;
}

export async function autoStartSttServer(db: DatabaseService) {
  if ((await db.getSetting("STT_PROVIDER")) !== "faster-whisper") return;
  if ((await db.getSetting("STT_SERVER_AUTO_START")) === "false") return;
  if ((await sttServerStatus(db)).reachable || operation) return;
  if (!(await sttEnvironmentReady())) return; // not set up yet - the Settings page offers "Umgebung einrichten"
  await controlSttServer(db, "start");
}

/** Transcribes via the running server. Throws when it's unreachable so callers can fall back. */
export async function transcribeViaSttServer(db: DatabaseService, audio: Buffer, opts: { language?: string; partial?: boolean }) {
  const url = new URL("transcribe", await sttServerUrl(db));
  if (opts.language) url.searchParams.set("language", opts.language);
  if (opts.partial) url.searchParams.set("partial", "1");
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(audio),
    signal: AbortSignal.timeout(opts.partial ? 15_000 : 120_000),
  });
  const body = await response.json().catch(() => ({})) as { text?: string; error?: string };
  if (!response.ok) throw new Error(body.error || `STT-Server HTTP ${response.status}`);
  return (body.text ?? "").trim();
}
