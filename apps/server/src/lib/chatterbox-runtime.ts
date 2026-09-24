import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseService } from "@ducki/database";

const scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));
let child: ChildProcess | undefined;
let operation: Promise<unknown> | undefined;
let lastError: string | undefined;
const intentionallyStopped = new WeakSet<ChildProcess>();

export function localChatterboxUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Serversteuerung erfordert eine lokale HTTP-URL (localhost oder 127.0.0.1 ohne Pfad).");
  }
  return url;
}

async function endpoint(db: DatabaseService) {
  return localChatterboxUrl(await db.getSetting("CHATTERBOX_SERVER_URL") || "http://127.0.0.1:8890");
}

export async function chatterboxStatus(db: DatabaseService) {
  const url = await endpoint(db);
  let health: Record<string, unknown> | undefined;
  try {
    const response = await fetch(new URL("health", url), { signal: AbortSignal.timeout(2000) });
    if (response.ok) health = await response.json() as Record<string, unknown>;
  } catch { /* A stopped server is a normal status. */ }
  return { reachable: !!health, managed: !!child, working: !!operation, error: lastError,
    autoStart: (await db.getSetting("CHATTERBOX_AUTO_START")) !== "false", health };
}

async function modelRequest(db: DatabaseService, action: "load" | "unload") {
  const response = await fetch(new URL(`model/${action}`, await endpoint(db)), {
    method: "POST", signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new Error(`Chatterbox: ${await response.text()}`);
}

async function start(db: DatabaseService) {
  if ((await chatterboxStatus(db)).reachable) return;
  const url = await endpoint(db);
  if (!child) {
    const venv = `${scripts}.venv/${process.platform === "win32" ? "Scripts/python.exe" : "bin/python"}`;
    const python = process.env["CHATTERBOX_PYTHON"] || (existsSync(venv) ? venv : "python");
    const proc = spawn(python, [`${scripts}chatterbox_server.py`], {
      cwd: scripts, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CHATTERBOX_HOST: "127.0.0.1", CHATTERBOX_PORT: url.port || "80", CHATTERBOX_LAZY_LOAD: "1", CHATTERBOX_MODEL: "v3" },
    });
    child = proc;
    proc.stdout?.on("data", (data: Buffer) => console.info(`[Chatterbox] ${data.toString().trim()}`));
    proc.stderr?.on("data", (data: Buffer) => { console.error(`[Chatterbox] ${data.toString().trim()}`); });
    proc.on("error", (error) => { lastError = error.message; if (child === proc) child = undefined; });
    proc.on("exit", (code) => {
      if (child === proc) { child = undefined; if (code && !intentionallyStopped.has(proc)) lastError = `Chatterbox beendet (Code ${code}). Python-Installation und Server-Log prüfen.`; }
    });
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!child) throw new Error(lastError || "Chatterbox konnte nicht gestartet werden.");
    if ((await chatterboxStatus(db)).reachable) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stopChatterbox();
  throw new Error("Chatterbox-Serverstart hat das Zeitlimit überschritten.");
}

export function stopChatterbox() {
  // Never terminate an unrelated process found by port or PID lookup.
  if (!child?.pid) return;
  intentionallyStopped.add(child);
  if (process.platform === "win32") {
    // A venv's python.exe is a launcher: terminate its owned interpreter child too.
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
  } else {
    child.kill();
  }
}

export function controlChatterbox(db: DatabaseService, action: "start" | "stop" | "load" | "unload") {
  if (operation) throw new Error("Eine Chatterbox-Aktion läuft bereits.");
  lastError = undefined;
  operation = (async () => {
    if (action === "stop") {
      if (!child) throw new Error("Dieser Server wurde extern gestartet. Bitte im ursprünglichen Terminal stoppen und danach hier starten.");
      const proc = child;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Server konnte nicht gestoppt werden.")), 10_000);
        proc.once("exit", () => { clearTimeout(timer); resolve(); });
        try { stopChatterbox(); }
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

export async function autoStartChatterbox(db: DatabaseService) {
  const provider = await db.getSetting("DEFAULT_TEXT_TO_SPEECH_PROVIDER") || "chatterbox";
  if (provider !== "chatterbox" || await db.getSetting("CHATTERBOX_AUTO_START") === "false") return;
  // External servers retain their own lifecycle, including deliberately unloaded models.
  if ((await chatterboxStatus(db)).reachable || operation) return;
  await controlChatterbox(db, "start");
}
