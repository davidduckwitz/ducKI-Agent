import { existsSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseService } from "@ducki/database";
import { chatterboxStatus } from "./chatterbox-runtime.js";
import { qwenTtsStatus, qwenVenvDir, resetQwenEnvironmentCache } from "./qwen-tts-runtime.js";
import { pocketTtsStatus, pocketVenvDir, resetPocketEnvironmentCache } from "./pocket-tts-runtime.js";
import { sttServerStatus } from "./stt-runtime.js";

/**
 * Disk usage of the local TTS/STT engines (Python venvs + downloaded Hugging Face models) and a
 * safe way to delete them. Only paths computed here are ever removed - never a client-supplied path.
 */
const scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));

type Engine = "qwen" | "pocket" | "chatterbox" | "stt";

export interface StorageItem {
  id: string;
  kind: "venv" | "model";
  label: string;
  description: string;
  path: string;
  engines: Engine[];
  sizeBytes: number;
  /** Set when the item cannot be deleted right now (engine server running). */
  blockedReason?: string;
}

interface ItemDef extends Omit<StorageItem, "sizeBytes" | "blockedReason"> {}

function hubDir(): string {
  const explicit = process.env["HF_HUB_CACHE"] || process.env["HUGGINGFACE_HUB_CACHE"];
  if (explicit) return explicit;
  return join(process.env["HF_HOME"] || join(homedir(), ".cache", "huggingface"), "hub");
}

const MODEL_PATTERNS: Array<{ test: RegExp; engines: Engine[] }> = [
  { test: /^models--Qwen--Qwen3-TTS/i, engines: ["qwen"] },
  { test: /^models--ResembleAI--chatterbox/i, engines: ["chatterbox"] },
  { test: /^models--kyutai--pocket-tts/i, engines: ["pocket"] },
  { test: /^models--[^-]+(?:-[^-]+)*--faster-whisper-/i, engines: ["stt"] },
];

function prettyModel(dirName: string): string {
  const [, org, name] = dirName.split("--");
  return org && name ? `${org}/${name}` : dirName;
}

async function listDefs(): Promise<ItemDef[]> {
  const defs: ItemDef[] = [];
  const qwenVenv = qwenVenvDir();
  defs.push({
    id: "venv-qwen", kind: "venv", label: "Qwen3-TTS Python-Umgebung",
    description: "PyTorch + qwen-tts (.venv-qwen). Neu installierbar über „Umgebung einrichten“.",
    path: qwenVenv, engines: ["qwen"],
  });
  defs.push({
    id: "venv-pocket", kind: "venv", label: "Pocket-TTS Python-Umgebung",
    description: "PyTorch (CPU) + pocket-tts (.venv-pocket). Neu installierbar über „Umgebung einrichten“.",
    path: pocketVenvDir(), engines: ["pocket"],
  });
  defs.push({
    id: "venv-shared", kind: "venv", label: "Chatterbox- & faster-whisper-Umgebung",
    description: "Gemeinsame Python-Umgebung (.venv) für Chatterbox und den STT-Server. Löschen deaktiviert beide, bis sie neu eingerichtet ist.",
    path: `${scripts}.venv`, engines: ["chatterbox", "stt"],
  });
  const hub = hubDir();
  if (existsSync(hub)) {
    for (const entry of (await readdir(hub, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const match = MODEL_PATTERNS.find((pattern) => pattern.test.test(entry.name));
      if (!match) continue;
      defs.push({
        id: `hf:${entry.name}`, kind: "model", label: prettyModel(entry.name),
        description: "Heruntergeladene Modellgewichte (Hugging Face Cache). Werden bei Bedarf automatisch neu geladen.",
        path: join(hub, entry.name), engines: match.engines,
      });
    }
  }
  return defs;
}

async function dirSize(root: string): Promise<number> {
  let total = 0;
  const queue = [root];
  while (queue.length) {
    const batch = queue.splice(0, 32);
    await Promise.all(batch.map(async (dir) => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      await Promise.all(entries.map(async (entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { queue.push(full); return; }
        try { total += (await lstat(full)).size; } catch { /* vanished file */ }
      }));
    }));
  }
  return total;
}

async function runningEngines(db: DatabaseService): Promise<Set<Engine>> {
  const [qwen, pocket, chatterbox, stt] = await Promise.all([
    qwenTtsStatus(db).catch(() => undefined),
    pocketTtsStatus(db).catch(() => undefined),
    chatterboxStatus(db).catch(() => undefined),
    sttServerStatus(db).catch(() => undefined),
  ]);
  const running = new Set<Engine>();
  if (qwen?.reachable || qwen?.working) running.add("qwen");
  if (pocket?.reachable || pocket?.working) running.add("pocket");
  if (chatterbox?.reachable || chatterbox?.working) running.add("chatterbox");
  if (stt?.reachable || stt?.working) running.add("stt");
  return running;
}

const ENGINE_NAMES: Record<Engine, string> = { qwen: "Qwen3-TTS", pocket: "Pocket TTS", chatterbox: "Chatterbox", stt: "der STT-Server" };

function blockedReason(def: ItemDef, running: Set<Engine>): string | undefined {
  const blocking = def.engines.filter((engine) => running.has(engine));
  return blocking.length ? `Erst ${blocking.map((engine) => ENGINE_NAMES[engine]).join(" und ")} stoppen.` : undefined;
}

export async function listStorage(db: DatabaseService): Promise<StorageItem[]> {
  const [defs, running] = await Promise.all([listDefs(), runningEngines(db)]);
  const existing = defs.filter((def) => existsSync(def.path));
  const sizes = await Promise.all(existing.map((def) => dirSize(def.path)));
  return existing.map((def, index) => ({ ...def, sizeBytes: sizes[index]!, blockedReason: blockedReason(def, running) }));
}

export async function deleteStorage(db: DatabaseService, id: string): Promise<void> {
  const def = (await listDefs()).find((candidate) => candidate.id === id);
  if (!def) throw new Error("Unbekannter Eintrag.");
  const reason = blockedReason(def, await runningEngines(db));
  if (reason) throw new Error(reason);
  // Defense in depth: the resolved path must be a real directory below a known root.
  const target = resolve(def.path);
  const allowedRoots = [resolve(scripts), resolve(hubDir()), resolve(qwenVenvDir()), resolve(pocketVenvDir())];
  if (!allowedRoots.some((root) => target === root || target.startsWith(root + sep))) throw new Error("Pfad nicht erlaubt.");
  // A venv is only ever removed if it really is one (guards a misconfigured QWEN_TTS_VENV_DIR).
  if (def.kind === "venv" && !existsSync(join(target, "pyvenv.cfg"))) throw new Error("Das ist keine Python-venv (pyvenv.cfg fehlt) - wird nicht gelöscht.");
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  } catch (error) {
    throw new Error(`Löschen fehlgeschlagen (Datei in Benutzung?): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (def.engines.includes("qwen")) resetQwenEnvironmentCache();
  if (def.engines.includes("pocket")) resetPocketEnvironmentCache();
}
