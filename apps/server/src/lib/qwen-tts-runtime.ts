import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseService } from "@ducki/database";
import { localChatterboxUrl } from "./chatterbox-runtime.js";
import { modelServerEnv } from "./secrets-store.js";

// Same lifecycle rules as chatterbox-runtime.ts: only a process we spawned ourselves is stopped.
const scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));
const DEFAULT_URL = "http://127.0.0.1:8892";
export const DEFAULT_QWEN_TTS_MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-Base";
let child: ChildProcess | undefined;
let operation: Promise<unknown> | undefined;
let lastError: string | undefined;
const intentionallyStopped = new WeakSet<ChildProcess>();

async function endpoint(db: DatabaseService) {
  return localChatterboxUrl(await db.getSetting("QWEN_TTS_SERVER_URL") || DEFAULT_URL);
}

// ---- Python environment -------------------------------------------------------------------
// qwen-tts pins its own transformers, so it gets a dedicated venv (.venv-qwen) and must NEVER
// fall back to Chatterbox's .venv or a system python ("No module named 'qwen_tts'").
// QWEN_TTS_VENV_DIR relocates the venv (several GB) to another drive when the project drive is small.
const VENV_DIR = (process.env["QWEN_TTS_VENV_DIR"] || `${scripts}.venv-qwen`).replace(/[\\/]+$/, "");
const VENV_PYTHON = `${VENV_DIR}/${process.platform === "win32" ? "Scripts/python.exe" : "bin/python"}`;
const REQUIREMENTS = `${scripts}requirements-qwen3-tts.txt`;
let setupPhase: string | undefined;
let envCache: { ready: boolean; cpuOnlyTorch: boolean; checkedAt: number } | undefined;

function pythonPath(): string | undefined {
  const override = process.env["QWEN_TTS_PYTHON"];
  if (override) return override;
  return existsSync(VENV_PYTHON) ? VENV_PYTHON : undefined;
}

export function run(command: string, args: string[], options: { timeoutMs?: number; cwd?: string } = {}):
    Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let proc: ChildProcess;
    try {
      proc = spawn(command, args, { cwd: options.cwd ?? scripts, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { resolve({ code: null, output: String(error) }); return; }
    const timer = options.timeoutMs ? setTimeout(() => proc.kill(), options.timeoutMs) : undefined;
    const collect = (data: Buffer) => { output = (output + data.toString()).slice(-4000); };
    proc.stdout?.on("data", collect);
    proc.stderr?.on("data", collect);
    proc.on("error", (error) => { if (timer) clearTimeout(timer); resolve({ code: null, output: error.message }); });
    proc.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code, output }); });
  });
}

export function qwenVenvDir(): string { return VENV_DIR; }
export function resetQwenEnvironmentCache(): void { envCache = undefined; }

let nvidiaPresent: boolean | undefined;
async function hasNvidiaGpu(): Promise<boolean> {
  nvidiaPresent ??= (await run("nvidia-smi", [], { timeoutMs: 10_000 })).code === 0;
  return nvidiaPresent;
}

/** Imports work; `cpuOnlyTorch` = an NVIDIA GPU exists but the installed torch is a CPU build (10x slower). */
async function inspectEnvironment(force = false): Promise<{ ready: boolean; cpuOnlyTorch: boolean }> {
  if (!force && envCache && Date.now() - envCache.checkedAt < 60_000) return envCache;
  const python = pythonPath();
  const probe = python
    ? await run(python, ["-c", "import qwen_tts, torch, flask; print('CUDA=' + str(torch.cuda.is_available()))"], { timeoutMs: 60_000 })
    : undefined;
  const ready = probe?.code === 0;
  const cpuOnlyTorch = ready && probe!.output.includes("CUDA=False") && await hasNvidiaGpu();
  envCache = { ready, cpuOnlyTorch, checkedAt: Date.now() };
  return envCache;
}

export async function qwenTtsEnvironmentReady(force = false): Promise<boolean> {
  return (await inspectEnvironment(force)).ready;
}

/** Creates .venv-qwen and installs torch + requirements. Several GB; only on explicit user action. */
async function setupEnvironment() {
  const fail = (message: string, output: string): never => {
    throw new Error(`${message}\n${output.trim().split("\n").slice(-6).join("\n")}`);
  };
  try {
    const hasUv = (await run("uv", ["--version"], { timeoutMs: 10_000 })).code === 0;
    if (!existsSync(VENV_PYTHON)) {
      setupPhase = "Erstelle Python-Umgebung (.venv-qwen) …";
      let created = false;
      let lastOutput = "";
      const candidates: Array<[string, string[]]> = [
        ...(hasUv ? [["uv", ["venv", VENV_DIR, "--python", "3.12"]] as [string, string[]]] : []),
        ...(process.platform === "win32" ? [["py", ["-3.12", "-m", "venv", VENV_DIR]] as [string, string[]]] : []),
        ["python3.12", ["-m", "venv", VENV_DIR]],
        ["python", ["-m", "venv", VENV_DIR]],
      ];
      for (const [command, args] of candidates) {
        const result = await run(command, args, { timeoutMs: 300_000 });
        lastOutput = result.output;
        if (result.code === 0 && existsSync(VENV_PYTHON)) { created = true; break; }
      }
      if (!created) fail("Python-Umgebung konnte nicht erstellt werden. Installiere Python 3.12 (oder uv: https://docs.astral.sh/uv/).", lastOutput);
    }
    const pip = (args: string[]) => hasUv
      ? run("uv", ["pip", "install", "--python", VENV_PYTHON, "--index-strategy", "unsafe-best-match", ...args], { timeoutMs: 3_600_000 })
      : run(VENV_PYTHON, ["-m", "pip", "install", ...args], { timeoutMs: 3_600_000 });
    // A plain `pip install qwen-tts` pulls the CPU-only torch from PyPI (10x slower synthesis), so on
    // NVIDIA machines torch comes from the CUDA index first and is replaced if a CPU build slipped in.
    const torchIndex = process.env["QWEN_TTS_TORCH_INDEX_URL"] || "https://download.pytorch.org/whl/cu126";
    const needsCudaTorch = (await hasNvidiaGpu()) && (!(await inspectEnvironment(true)).ready || (await inspectEnvironment()).cpuOnlyTorch);
    if (needsCudaTorch) {
      setupPhase = "Installiere PyTorch (CUDA) – mehrere GB, das dauert …";
      const torch = await pip(["torch", hasUv ? "--reinstall-package=torch" : "--force-reinstall", "--index-url", torchIndex, "--extra-index-url", "https://pypi.org/simple"]);
      if (torch.code !== 0) fail("PyTorch-Installation fehlgeschlagen (Speicherplatz auf dem Laufwerk der venv prüfen).", torch.output);
    }
    setupPhase = "Installiere qwen-tts und Abhängigkeiten …";
    const reqs = await pip(["-r", REQUIREMENTS]);
    if (reqs.code !== 0) fail("Installation von qwen-tts fehlgeschlagen.", reqs.output);
    setupPhase = "Prüfe Installation …";
    if (!(await qwenTtsEnvironmentReady(true))) {
      const check = await run(VENV_PYTHON, ["-c", "import qwen_tts, torch, flask"], { timeoutMs: 60_000 });
      fail("Installation abgeschlossen, aber qwen_tts ist nicht importierbar.", check.output);
    }
    if (envCache?.cpuOnlyTorch) fail("PyTorch wurde ohne CUDA-Unterstützung installiert, obwohl eine NVIDIA-GPU vorhanden ist. Treiber prüfen oder QWEN_TTS_TORCH_INDEX_URL setzen.", "");
  } finally { setupPhase = undefined; }
}

export async function qwenTtsStatus(db: DatabaseService) {
  const url = await endpoint(db);
  let health: Record<string, unknown> | undefined;
  try {
    const response = await fetch(new URL("health", url), { signal: AbortSignal.timeout(2000) });
    if (response.ok) health = await response.json() as Record<string, unknown>;
  } catch { /* A stopped server is a normal status. */ }
  return { reachable: !!health, managed: !!child, working: !!operation, phase: setupPhase, error: lastError,
    envReady: health ? true : await qwenTtsEnvironmentReady(),
    cpuOnlyTorch: health ? false : (await inspectEnvironment()).cpuOnlyTorch,
    autoStart: (await db.getSetting("QWEN_TTS_AUTO_START")) !== "false", health };
}

async function modelRequest(db: DatabaseService, action: "load" | "unload") {
  const response = await fetch(new URL(`model/${action}`, await endpoint(db)), {
    method: "POST", signal: AbortSignal.timeout(600_000), // first load downloads the weights
  });
  if (!response.ok) throw new Error(`Qwen3-TTS: ${await response.text()}`);
}

async function start(db: DatabaseService) {
  if ((await qwenTtsStatus(db)).reachable) return;
  const url = await endpoint(db);
  if (!child) {
    if (!(await qwenTtsEnvironmentReady(true))) {
      throw new Error("Die Python-Umgebung für Qwen3-TTS fehlt oder ist unvollständig (qwen_tts nicht installiert). Bitte zuerst „Umgebung einrichten“ wählen.");
    }
    const python = pythonPath()!;
    const proc = spawn(python, [`${scripts}qwen3_tts_server.py`], {
      cwd: scripts, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(await modelServerEnv(db)), QWEN_TTS_HOST: "127.0.0.1", QWEN_TTS_PORT: url.port || "80", QWEN_TTS_LAZY_LOAD: "1",
        QWEN_TTS_MODEL: await db.getSetting("QWEN_TTS_MODEL") || DEFAULT_QWEN_TTS_MODEL },
    });
    child = proc;
    proc.stdout?.on("data", (data: Buffer) => console.info(`[Qwen3-TTS] ${data.toString().trim()}`));
    proc.stderr?.on("data", (data: Buffer) => { console.error(`[Qwen3-TTS] ${data.toString().trim()}`); });
    proc.on("error", (error) => { lastError = error.message; if (child === proc) child = undefined; });
    proc.on("exit", (code) => {
      if (child === proc) { child = undefined; if (code && !intentionallyStopped.has(proc)) lastError = `Qwen3-TTS beendet (Code ${code}). Python-Installation (requirements-qwen3-tts.txt) und Server-Log prüfen.`; }
    });
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!child) throw new Error(lastError || "Qwen3-TTS konnte nicht gestartet werden.");
    if ((await qwenTtsStatus(db)).reachable) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stopQwenTts();
  throw new Error("Qwen3-TTS-Serverstart hat das Zeitlimit überschritten.");
}

export function stopQwenTts() {
  if (!child?.pid) return;
  intentionallyStopped.add(child);
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
  } else {
    child.kill();
  }
}

export function controlQwenTts(db: DatabaseService, action: "start" | "stop" | "load" | "unload" | "setup") {
  if (operation) throw new Error("Eine Qwen3-TTS-Aktion läuft bereits.");
  lastError = undefined;
  operation = (async () => {
    if (action === "setup") {
      await setupEnvironment();
    } else if (action === "stop") {
      if (!child) throw new Error("Dieser Server wurde extern gestartet. Bitte im ursprünglichen Terminal stoppen und danach hier starten.");
      const proc = child;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Server konnte nicht gestoppt werden.")), 10_000);
        proc.once("exit", () => { clearTimeout(timer); resolve(); });
        try { stopQwenTts(); }
        catch (error) { clearTimeout(timer); reject(error); }
      });
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

export async function autoStartQwenTts(db: DatabaseService) {
  const provider = await db.getSetting("DEFAULT_TEXT_TO_SPEECH_PROVIDER") || "chatterbox";
  if (provider !== "qwen3-tts" || await db.getSetting("QWEN_TTS_AUTO_START") === "false") return;
  if ((await qwenTtsStatus(db)).reachable || operation) return;
  // Autostart never triggers the multi-GB install; the user opts in via "Umgebung einrichten".
  if (!(await qwenTtsEnvironmentReady())) { lastError = "Python-Umgebung fehlt – bitte „Umgebung einrichten“ wählen."; return; }
  await controlQwenTts(db, "start");
}
