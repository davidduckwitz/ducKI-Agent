import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseService } from "@ducki/database";
import { localChatterboxUrl } from "./chatterbox-runtime.js";
import { run } from "./qwen-tts-runtime.js";
import { modelServerEnv } from "./secrets-store.js";

// Same lifecycle rules as chatterbox-runtime.ts / qwen-tts-runtime.ts: only a process we spawned
// ourselves is ever stopped. Pocket TTS is CPU-first, so there is no CUDA handling here.
const scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));
const DEFAULT_URL = "http://127.0.0.1:8893";
export const DEFAULT_POCKET_TTS_LANGUAGE = "german";
let child: ChildProcess | undefined;
let operation: Promise<unknown> | undefined;
let lastError: string | undefined;
let setupPhase: string | undefined;
const intentionallyStopped = new WeakSet<ChildProcess>();

// POCKET_TTS_VENV_DIR relocates the venv to another drive when the project drive is small.
const VENV_DIR = (process.env["POCKET_TTS_VENV_DIR"] || `${scripts}.venv-pocket`).replace(/[\\/]+$/, "");
const VENV_PYTHON = `${VENV_DIR}/${process.platform === "win32" ? "Scripts/python.exe" : "bin/python"}`;
const REQUIREMENTS = `${scripts}requirements-pocket-tts.txt`;
let envCache: { ready: boolean; checkedAt: number } | undefined;

export function pocketVenvDir(): string { return VENV_DIR; }
export function resetPocketEnvironmentCache(): void { envCache = undefined; }

async function endpoint(db: DatabaseService) {
  return localChatterboxUrl(await db.getSetting("POCKET_TTS_SERVER_URL") || DEFAULT_URL);
}

function pythonPath(): string | undefined {
  const override = process.env["POCKET_TTS_PYTHON"];
  if (override) return override;
  return existsSync(VENV_PYTHON) ? VENV_PYTHON : undefined;
}

export async function pocketTtsEnvironmentReady(force = false): Promise<boolean> {
  if (!force && envCache && Date.now() - envCache.checkedAt < 60_000) return envCache.ready;
  const python = pythonPath();
  const ready = !!python && (await run(python, ["-c", "import pocket_tts, flask"], { timeoutMs: 60_000 })).code === 0;
  envCache = { ready, checkedAt: Date.now() };
  return ready;
}

/** Creates .venv-pocket and installs the requirements (a few hundred MB). Only on explicit user action. */
async function setupEnvironment() {
  const fail = (message: string, output: string): never => {
    throw new Error(`${message}\n${output.trim().split("\n").slice(-6).join("\n")}`);
  };
  try {
    const hasUv = (await run("uv", ["--version"], { timeoutMs: 10_000 })).code === 0;
    if (!existsSync(VENV_PYTHON)) {
      setupPhase = "Erstelle Python-Umgebung (.venv-pocket) …";
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
      if (!created) fail("Python-Umgebung konnte nicht erstellt werden. Installiere Python 3.10–3.14 (oder uv: https://docs.astral.sh/uv/).", lastOutput);
    }
    setupPhase = "Installiere Pocket TTS und PyTorch (CPU) …";
    const install = hasUv
      ? await run("uv", ["pip", "install", "--python", VENV_PYTHON, "-r", REQUIREMENTS], { timeoutMs: 3_600_000 })
      : await run(VENV_PYTHON, ["-m", "pip", "install", "-r", REQUIREMENTS], { timeoutMs: 3_600_000 });
    if (install.code !== 0) fail("Installation von pocket-tts fehlgeschlagen (Speicherplatz auf dem Laufwerk der venv prüfen).", install.output);
    setupPhase = "Prüfe Installation …";
    if (!(await pocketTtsEnvironmentReady(true))) {
      const check = await run(VENV_PYTHON, ["-c", "import pocket_tts, flask"], { timeoutMs: 60_000 });
      fail("Installation abgeschlossen, aber pocket_tts ist nicht importierbar.", check.output);
    }
  } finally { setupPhase = undefined; }
}

export async function pocketTtsStatus(db: DatabaseService) {
  const url = await endpoint(db);
  let health: Record<string, unknown> | undefined;
  try {
    const response = await fetch(new URL("health", url), { signal: AbortSignal.timeout(2000) });
    if (response.ok) health = await response.json() as Record<string, unknown>;
  } catch { /* A stopped server is a normal status. */ }
  return { reachable: !!health, managed: !!child, working: !!operation, phase: setupPhase, error: lastError,
    envReady: health ? true : await pocketTtsEnvironmentReady(),
    autoStart: (await db.getSetting("POCKET_TTS_AUTO_START")) !== "false", health };
}

async function modelRequest(db: DatabaseService, action: "load" | "unload") {
  const response = await fetch(new URL(`model/${action}`, await endpoint(db)), {
    method: "POST", signal: AbortSignal.timeout(600_000), // first load downloads the weights
  });
  if (!response.ok) throw new Error(`Pocket TTS: ${await response.text()}`);
}

async function start(db: DatabaseService) {
  if ((await pocketTtsStatus(db)).reachable) return;
  const url = await endpoint(db);
  if (!child) {
    if (!(await pocketTtsEnvironmentReady(true))) {
      throw new Error("Die Python-Umgebung für Pocket TTS fehlt oder ist unvollständig (pocket_tts nicht installiert). Bitte zuerst „Umgebung einrichten“ wählen.");
    }
    const proc = spawn(pythonPath()!, [`${scripts}pocket_tts_server.py`], {
      cwd: scripts, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(await modelServerEnv(db)), POCKET_TTS_HOST: "127.0.0.1", POCKET_TTS_PORT: url.port || "80", POCKET_TTS_LAZY_LOAD: "1",
        POCKET_TTS_LANGUAGE: await db.getSetting("POCKET_TTS_LANGUAGE") || DEFAULT_POCKET_TTS_LANGUAGE,
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1" },
    });
    child = proc;
    proc.stdout?.on("data", (data: Buffer) => console.info(`[Pocket TTS] ${data.toString().trim()}`));
    proc.stderr?.on("data", (data: Buffer) => { console.error(`[Pocket TTS] ${data.toString().trim()}`); });
    proc.on("error", (error) => { lastError = error.message; if (child === proc) child = undefined; });
    proc.on("exit", (code) => {
      if (child === proc) { child = undefined; if (code && !intentionallyStopped.has(proc)) lastError = `Pocket TTS beendet (Code ${code}). Installation (requirements-pocket-tts.txt) und Server-Log prüfen.`; }
    });
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!child) throw new Error(lastError || "Pocket TTS konnte nicht gestartet werden.");
    if ((await pocketTtsStatus(db)).reachable) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stopPocketTts();
  throw new Error("Pocket-TTS-Serverstart hat das Zeitlimit überschritten.");
}

export function stopPocketTts() {
  if (!child?.pid) return;
  intentionallyStopped.add(child);
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
  } else {
    child.kill();
  }
}

export function controlPocketTts(db: DatabaseService, action: "start" | "stop" | "load" | "unload" | "setup") {
  if (operation) throw new Error("Eine Pocket-TTS-Aktion läuft bereits.");
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
        try { stopPocketTts(); }
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

export async function autoStartPocketTts(db: DatabaseService) {
  const provider = await db.getSetting("DEFAULT_TEXT_TO_SPEECH_PROVIDER") || "chatterbox";
  if (provider !== "pocket-tts" || await db.getSetting("POCKET_TTS_AUTO_START") === "false") return;
  if ((await pocketTtsStatus(db)).reachable || operation) return;
  // Autostart never triggers the install; the user opts in via "Umgebung einrichten".
  if (!(await pocketTtsEnvironmentReady())) { lastError = "Python-Umgebung fehlt – bitte „Umgebung einrichten“ wählen."; return; }
  await controlPocketTts(db, "start");
}
