import { Router, type IRouter } from "express";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createApiError, createApiResponse, duckiHome } from "@ducki/shared";

/**
 * Model store for the browser-side wake-word engines (openWakeWord via onnxruntime-web,
 * Porcupine via its WASM SDK). Detection itself runs in the browser on the mic stream; the
 * server only downloads the model files on first use, caches them under ~/DucKI/wakeword and
 * keeps the user's own uploads (Colab-trained .onnx, Picovoice-Console .ppn).
 */

type Engine = "openwakeword" | "porcupine";

const OWW_RELEASE = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1";
const PORCUPINE_COMMON = "https://raw.githubusercontent.com/Picovoice/porcupine/master/lib/common";
const COMMUNITY_REPO = "fwartner/home-assistant-wakewords-collection";
const COMMUNITY_RAW = `https://raw.githubusercontent.com/${COMMUNITY_REPO}/main`;

/** Feature models every openWakeWord classifier needs, plus the official pre-trained words. */
const OWW_FEATURE_FILES = ["melspectrogram.onnx", "embedding_model.onnx"];
const OWW_BUILTIN: Array<{ id: string; label: string; file: string }> = [
  { id: "hey_jarvis", label: "Hey Jarvis", file: "hey_jarvis_v0.1.onnx" },
  { id: "alexa", label: "Alexa", file: "alexa_v0.1.onnx" },
  { id: "hey_mycroft", label: "Hey Mycroft", file: "hey_mycroft_v0.1.onnx" },
  { id: "hey_rhasspy", label: "Hey Rhasspy", file: "hey_rhasspy_v0.1.onnx" },
];
const PORCUPINE_PARAMS: Record<string, string> = { en: "porcupine_params.pv", de: "porcupine_params_de.pv" };

const COMMUNITY_TTL_MS = 24 * 60 * 60 * 1000;
let communityCache: { at: number; models: Array<{ id: string; label: string; language: string; path: string }> } | null = null;

function storeDir(engine: Engine, kind: "builtin" | "custom" | "community"): string {
  const dir = resolve(duckiHome(), "wakeword", engine, kind);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Only plain file names - no separators, no traversal. */
function safeName(name: unknown, ext: string): string | null {
  if (typeof name !== "string") return null;
  const clean = basename(name.trim());
  if (!clean || clean !== name.trim() || clean.startsWith(".") || !clean.toLowerCase().endsWith(ext)) return null;
  return /^[\w .()-]+$/.test(clean) ? clean : null;
}

const pending = new Map<string, Promise<void>>();

async function download(url: string, target: string): Promise<void> {
  if (existsSync(target)) return;
  const running = pending.get(target);
  if (running) return running;
  const job = (async () => {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status}): ${url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 1024) throw new Error(`Download unvollständig: ${url}`);
    const temp = `${target}.part`;
    writeFileSync(temp, bytes);
    renameSync(temp, target);
  })().finally(() => pending.delete(target));
  pending.set(target, job);
  return job;
}

function listCustom(engine: Engine, ext: string): Array<{ id: string; label: string; size: number }> {
  const dir = storeDir(engine, "custom");
  return readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith(ext))
    .map((file) => ({ id: file, label: file.slice(0, -ext.length).replace(/[_-]+/g, " "), size: statSync(join(dir, file)).size }));
}

async function communityModels() {
  if (communityCache && Date.now() - communityCache.at < COMMUNITY_TTL_MS) return communityCache.models;
  const res = await fetch(`https://api.github.com/repos/${COMMUNITY_REPO}/git/trees/main?recursive=1`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "DucKI" },
  });
  if (!res.ok) throw new Error(`Community-Liste nicht erreichbar (${res.status})`);
  const tree = (await res.json()) as { tree?: Array<{ path: string; type: string }> };
  const models = (tree.tree ?? [])
    .filter((entry) => entry.type === "blob" && entry.path.endsWith(".onnx") && entry.path.split("/").length === 3)
    .map((entry) => {
      const [language = "", folder = ""] = entry.path.split("/");
      return { id: entry.path, label: folder.replace(/[_]+/g, " ").trim(), language, path: entry.path };
    })
    .sort((a, b) => a.language.localeCompare(b.language) || a.label.localeCompare(b.label));
  communityCache = { at: Date.now(), models };
  return models;
}

/** Resolves (and downloads on first use) the local path for a model reference. */
async function resolveModelFile(engine: Engine, source: string, id: string): Promise<string | null> {
  if (engine === "openwakeword") {
    if (source === "feature") {
      if (!OWW_FEATURE_FILES.includes(id)) return null;
      const target = join(storeDir(engine, "builtin"), id);
      await download(`${OWW_RELEASE}/${id}`, target);
      return target;
    }
    if (source === "builtin") {
      const model = OWW_BUILTIN.find((entry) => entry.id === id);
      if (!model) return null;
      const target = join(storeDir(engine, "builtin"), model.file);
      await download(`${OWW_RELEASE}/${model.file}`, target);
      return target;
    }
    if (source === "community") {
      const model = (await communityModels()).find((entry) => entry.id === id);
      if (!model) return null;
      const target = join(storeDir(engine, "community"), model.path.replace(/[/\\ ]+/g, "__"));
      await download(`${COMMUNITY_RAW}/${model.path.split("/").map(encodeURIComponent).join("/")}`, target);
      return target;
    }
    if (source === "custom") {
      const name = safeName(id, ".onnx");
      const target = name && join(storeDir(engine, "custom"), name);
      return target && existsSync(target) ? target : null;
    }
    return null;
  }
  if (source === "params") {
    const file = PORCUPINE_PARAMS[id];
    if (!file) return null;
    const target = join(storeDir(engine, "builtin"), file);
    await download(`${PORCUPINE_COMMON}/${file}`, target);
    return target;
  }
  if (source === "custom") {
    const name = safeName(id, ".ppn");
    const target = name && join(storeDir(engine, "custom"), name);
    return target && existsSync(target) ? target : null;
  }
  return null;
}

export const wakewordRouter: IRouter = Router();

wakewordRouter.get("/models", (_req, res) => {
  const builtinDir = storeDir("openwakeword", "builtin");
  res.json(createApiResponse({
    openwakeword: {
      builtin: OWW_BUILTIN.map((model) => ({ id: model.id, label: model.label, installed: existsSync(join(builtinDir, model.file)) })),
      custom: listCustom("openwakeword", ".onnx"),
    },
    porcupine: {
      params: Object.entries(PORCUPINE_PARAMS).map(([id, file]) => ({ id, installed: existsSync(join(storeDir("porcupine", "builtin"), file)) })),
      custom: listCustom("porcupine", ".ppn"),
    },
  }));
});

wakewordRouter.get("/community", async (_req, res) => {
  try {
    res.json(createApiResponse(await communityModels()));
  } catch (error) {
    res.status(502).json(createApiError(error instanceof Error ? error.message : "Community-Liste nicht erreichbar"));
  }
});

// GET /file/openwakeword/builtin/hey_jarvis, /file/porcupine/params/de, /file/openwakeword/community/<path> ...
wakewordRouter.get(/^\/file\/(openwakeword|porcupine)\/(feature|builtin|community|custom|params)\/(.+)$/, async (req, res) => {
  const params = req.params as unknown as Record<string, string>;
  const engine = params["0"] as Engine;
  const source = params["1"] ?? "";
  const id = decodeURIComponent(params["2"] ?? "");
  try {
    const file = await resolveModelFile(engine, source, id);
    if (!file) return void res.status(404).json(createApiError("Modell nicht gefunden"));
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.type("application/octet-stream").sendFile(file);
  } catch (error) {
    res.status(502).json(createApiError(error instanceof Error ? error.message : "Modell-Download fehlgeschlagen"));
  }
});

wakewordRouter.post("/custom/:engine", (req, res) => {
  const engine = req.params["engine"];
  if (engine !== "openwakeword" && engine !== "porcupine") return void res.status(404).json(createApiError("Unbekannte Engine"));
  const name = safeName(req.body?.name, engine === "openwakeword" ? ".onnx" : ".ppn");
  if (!name) return void res.status(400).json(createApiError(engine === "openwakeword" ? "Bitte eine .onnx-Datei hochladen" : "Bitte eine .ppn-Datei hochladen"));
  const data = typeof req.body?.data === "string" ? Buffer.from(req.body.data, "base64") : null;
  if (!data || data.length < 1024 || data.length > 20 * 1024 * 1024) return void res.status(400).json(createApiError("Ungültige Modelldatei"));
  writeFileSync(join(storeDir(engine, "custom"), name), data);
  res.json(createApiResponse({ id: name }));
});

wakewordRouter.delete("/custom/:engine/:name", (req, res) => {
  const engine = req.params["engine"];
  if (engine !== "openwakeword" && engine !== "porcupine") return void res.status(404).json(createApiError("Unbekannte Engine"));
  const name = safeName(req.params["name"], engine === "openwakeword" ? ".onnx" : ".ppn");
  const target = name && join(storeDir(engine, "custom"), name);
  if (!target || !existsSync(target)) return void res.status(404).json(createApiError("Modell nicht gefunden"));
  unlinkSync(target);
  res.json(createApiResponse({ deleted: name }));
});
