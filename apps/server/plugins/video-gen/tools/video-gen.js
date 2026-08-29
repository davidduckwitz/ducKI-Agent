/**
 * Local video generation (trust: "node"). Sibling of the image-gen plugin - same sidecar/venv/
 * model-management pattern (see plugins/image-gen/tools/image-gen.js for the fuller doc comment
 * this was cloned from), adapted for text-to-video instead of text-to-image:
 *   - no img2img/reference/live-preview support (video models here don't cheaply support it the
 *     way diffusers' AutoPipelineForImage2Image.from_pipe() does for SD-class image models)
 *   - one generation returns an MP4 (base64) instead of a PNG
 *   - four selectable model families (Wan2.1, LTX-Video, HunyuanVideo, CogVideoX), all
 *     considerably heavier than image-gen's SD-Turbo-class models - expect multi-minute
 *     generations even on a good GPU, and treat CPU-only as "works in principle, not in practice"
 *
 * SETUP: action=install creates runtime/.venv and installs torch + diffusers/transformers/etc
 * (see runtime/requirements.txt) - identical flow to image-gen. Model WEIGHTS are a separate,
 * per-model concern (several GB to 25+ GB each) - action=install_model downloads one model's
 * weights via huggingface_hub.snapshot_download without loading/running it, action=list_models
 * reports download/loaded status, action=uninstall_model deletes a model's cached weights,
 * action=unload_model/stop_engine frees the sidecar process (and with it, VRAM/RAM).
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, rmSync, readdirSync, statSync } from "node:fs";

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const GENERATED_DIR = join(PLUGIN_DIR, "data", "generated");
const SERVER_SCRIPT = join(PLUGIN_DIR, "runtime", "server.py");
const REQUIREMENTS_FILE = join(PLUGIN_DIR, "runtime", "requirements.txt");
const VENV_DIR = join(PLUGIN_DIR, "runtime", ".venv");

/** Mirrors runtime/server.py's MODEL_MAP - kept here too so the JS side can locate/size/delete a
 *  model's local huggingface_hub cache folder without having to shell out to Python for it. */
const MODEL_MAP = {
  "wan2.1-1.3b": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
  "ltx-video": "Lightricks/LTX-Video",
  "hunyuanvideo": "tencent/HunyuanVideo",
  "cogvideox-2b": "THUDM/CogVideoX-2b",
};

const HEALTH_POLL_INTERVAL_MS = 1000;
const HEALTH_POLL_TIMEOUT_MS = 180_000; // cold start can include a multi-GB model load, video models are slower to load than image-gen's
const INSTALL_LOG_MAX_LINES = 300;

/** @type {{ child: import("node:child_process").ChildProcess | null, port: number | null, ready: Promise<void> | null }} */
const sidecar = { child: null, port: null, ready: null };

/** @type {{ phase: "idle"|"creating_venv"|"installing_torch"|"installing_deps"|"done"|"error", log: string[], error: string | null }} */
const install = { phase: "idle", log: [], error: null };

export const definition = {
  name: "video_gen",
  description:
    "Generiert kurze Video-Clips lokal mit einem Text-zu-Video-Diffusionsmodell (Wan2.1, LTX-Video, HunyuanVideo oder CogVideoX), ueber einen eigenen Python-Sidecar - keine Cloud, keine fremde Oberflaeche. Deutlich schwerer/langsamer als das Schwester-Tool image_gen (Minuten statt Sekunden pro Clip, braucht eine ordentliche GPU). " +
    "action=generate (prompt, negative_prompt?, width?, height?, num_frames?, fps?, steps?, guidance_scale?, seed?, model?) erzeugt einen Clip und liefert eine Datei-URL zurueck (MP4). " +
    "num_frames/fps bestimmen die Laenge (Sekunden = num_frames/fps) - Standardwerte sind modellabhaengig (siehe action=list_models fuer die Modellnamen); hoehere Werte = laenger UND langsamer zu generieren. " +
    "guidance_scale (CFG) und steps sind modellabhaengig vorbelegt - nur gezielt aendern, meist sind die Defaults die vom jeweiligen Modell empfohlenen Werte. " +
    "action=list (limit?, offset?) listet zuletzt erzeugte Clips, paginiert - liefert {items, total, limit, offset, hasMore}. " +
    "action=analyze (id, question?) laesst dich EINEN Frame des erzeugten Clips tatsaechlich ansehen (Vision-Modell) - nutze es, um zu pruefen ob das Ergebnis zum Prompt passt. Ohne diese Action siehst du den Clip NICHT, nur eine URL. " +
    "action=suggest_prompt (idea) baut aus einer groben Idee per LLM einen ausformulierten Videogenerierungs-Prompt. " +
    "action=delete (id) loescht einen generierten Clip dauerhaft (Datei + Datenbankeintrag). " +
    "action=install richtet die Python-Umgebung automatisch ein (venv + PyTorch/diffusers, GPU wird automatisch erkannt) - beim ersten Mal noetig, dauert mehrere Minuten. " +
    "action=status liefert den Einrichtungsfortschritt (ready, phase, log). " +
    "action=stop_engine beendet den lokalen Sidecar-Prozess sofort (sonst beendet er sich nach Leerlauf selbst). " +
    "action=list_models listet die bekannten Modelle (wan2.1-1.3b/ltx-video/hunyuanvideo/cogvideox-2b) mit Download-Status, Groesse auf der Festplatte und ob es gerade im Speicher geladen ist. " +
    "action=unload_model entlaedt das aktuell im Speicher geladene Modell (beendet den Sidecar-Prozess, identisch zu stop_engine - der Sidecar haelt immer nur ein Modell gleichzeitig). " +
    "action=uninstall_model (model) loescht die heruntergeladenen Gewichte eines Modells dauerhaft von der Festplatte (huggingface_hub-Cache, oft 5-25+ GB pro Modell) - bei erneuter Nutzung wird es neu heruntergeladen. " +
    "action=install_model (model) laedt nur die Gewichte eines Modells herunter, OHNE es zu laden oder einen Clip zu generieren - fuer gezieltes Vorab-Herunterladen. Fortschritt ueber action=list_models (downloading/download_error).",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["generate", "list", "analyze", "suggest_prompt", "delete", "install", "status", "stop_engine", "list_models", "unload_model", "uninstall_model", "install_model"], description: "Welche Operation ausgefuehrt wird" },
      prompt: { type: "string", description: "Videobeschreibung (Englisch funktioniert meist am besten) - Bewegung/Handlung explizit beschreiben, nicht nur ein statisches Motiv" },
      negative_prompt: { type: "string", description: "Was im Video vermieden werden soll" },
      width: { type: "number", description: "Breite in Pixeln, Standard modellabhaengig" },
      height: { type: "number", description: "Hoehe in Pixeln, Standard modellabhaengig" },
      num_frames: { type: "number", description: "Anzahl Frames, Standard modellabhaengig - Clip-Laenge in Sekunden = num_frames/fps" },
      fps: { type: "number", description: "Bilder pro Sekunde im exportierten MP4, Standard modellabhaengig" },
      steps: { type: "number", description: "Anzahl Diffusionsschritte, Standard modellabhaengig (meist um 50). Mehr = i.d.R. mehr Detail, aber deutlich langsamer." },
      guidance_scale: { type: "number", description: "CFG-Wert, Standard modellabhaengig. Hoeher = folgt dem Prompt staerker, kann aber uebersaettigt/verzerrt wirken." },
      seed: { type: "number", description: "Fester Seed fuer reproduzierbare Ergebnisse" },
      model: { type: "string", enum: ["wan2.1-1.3b", "ltx-video", "hunyuanvideo", "cogvideox-2b"], description: "Modell-Override fuer diese eine Generierung (sonst Plugin-Einstellung VIDEO_MODEL); fuer action=uninstall_model/install_model das betroffene Modell" },
      limit: { type: "number", description: "Max. Anzahl Ergebnisse fuer action=list, Standard 24" },
      offset: { type: "number", description: "Anzahl zu ueberspringender Ergebnisse fuer action=list (Pagination), Standard 0" },
      id: { type: "string", description: "ID des erzeugten Clips fuer action=analyze/delete (aus generate/list)" },
      question: { type: "string", description: "Konkrete Frage ans Vision-Modell fuer action=analyze, z. B. 'Wirkt die Bewegung fluessig?' (Standard: allgemeine Beschreibung + Prompt-Abgleich)" },
      idea: { type: "string", description: "Grobe, auch unvollstaendige Idee fuer action=suggest_prompt, z. B. 'welle bricht am strand'" },
    },
    required: ["action"],
  },
};

async function ensureSchema(storage) {
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS generations (" +
      "id TEXT PRIMARY KEY, " +
      "prompt TEXT NOT NULL, " +
      "negative_prompt TEXT, " +
      "model TEXT NOT NULL, " +
      "width INTEGER NOT NULL, " +
      "height INTEGER NOT NULL, " +
      "num_frames INTEGER, " +
      "fps INTEGER, " +
      "seed INTEGER, " +
      "file_path TEXT NOT NULL, " +
      "poster_data_url TEXT, " +
      "created_at TEXT NOT NULL, " +
      "ai_analysis TEXT, " +
      "steps INTEGER, " +
      "guidance_scale REAL" +
      ")"
  );
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : null;
      srv.close(() => (port ? resolvePort(port) : rejectPort(new Error("could not allocate a port"))));
    });
  });
}

// --- Python environment (venv) -------------------------------------------------------------

function venvPythonPath() {
  return process.platform === "win32" ? join(VENV_DIR, "Scripts", "python.exe") : join(VENV_DIR, "bin", "python3");
}

function hasVenv() {
  return existsSync(venvPythonPath());
}

function effectivePythonPath(ctx) {
  if (hasVenv()) return venvPythonPath();
  return String(ctx.settings.PYTHON_PATH || "python").trim() || "python";
}

function pushInstallLog(line) {
  install.log.push(line);
  if (install.log.length > INSTALL_LOG_MAX_LINES) install.log.splice(0, install.log.length - INSTALL_LOG_MAX_LINES);
}

function runInstallStep(command, args, logFn = pushInstallLog) {
  return new Promise((resolveStep, rejectStep) => {
    const child = spawn(command, args, { cwd: PLUGIN_DIR, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    // Keep the tail of combined stdout/stderr so a failure can report the ACTUAL Python error
    // (traceback, HF auth/gated-repo message, missing package, ...) - just echoing the command
    // back (as this used to do) tells the user nothing about why it failed.
    let outputTail = "";
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      outputTail = (outputTail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) logFn(line.trim());
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", rejectStep);
    child.on("exit", (code) => {
      if (code === 0) resolveStep();
      else {
        const reason = outputTail.trim().slice(-800) || `${command} ${args.join(" ")}`;
        rejectStep(new Error(`Befehl fehlgeschlagen (exit ${code}): ${reason}`));
      }
    });
  });
}

/** Best-effort NVIDIA GPU detection (nvidia-smi exit code), used to pick a CUDA torch build. */
function detectNvidiaGpu() {
  return new Promise((resolveGpu) => {
    const child = spawn("nvidia-smi", ["-L"], { stdio: "ignore", windowsHide: true, shell: false });
    child.on("error", () => resolveGpu(false));
    child.on("exit", (code) => resolveGpu(code === 0));
  });
}

async function runInstall(ctx) {
  install.phase = "creating_venv";
  install.error = null;
  install.log = [];
  try {
    const basePython = String(ctx.settings.PYTHON_PATH || "python").trim() || "python";
    if (!hasVenv()) {
      pushInstallLog(`Erstelle virtuelle Umgebung mit '${basePython}'...`);
      await runInstallStep(basePython, ["-m", "venv", VENV_DIR]);
    } else {
      pushInstallLog("Virtuelle Umgebung existiert bereits.");
    }

    const venvPython = venvPythonPath();
    const device = String(ctx.settings.DEVICE || "auto");
    const wantsCuda = device === "cuda" || (device === "auto" && (await detectNvidiaGpu()));

    install.phase = "installing_torch";
    if (wantsCuda) {
      pushInstallLog("NVIDIA-GPU erkannt (oder DEVICE=cuda) - installiere PyTorch mit CUDA-Unterstuetzung...");
      await runInstallStep(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
      await runInstallStep(venvPython, ["-m", "pip", "install", "torch", "--index-url", "https://download.pytorch.org/whl/cu124"]);
    } else {
      pushInstallLog("Keine NVIDIA-GPU erkannt (oder DEVICE=cpu) - installiere PyTorch (CPU, fuer Video kaum praktikabel)...");
      await runInstallStep(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
      await runInstallStep(venvPython, ["-m", "pip", "install", "torch"]);
    }

    install.phase = "installing_deps";
    // Installed ONE PACKAGE AT A TIME rather than a single `pip install -r requirements.txt` -
    // pip resolves+installs a -r file as one transaction, so if ANY single package has no
    // prebuilt wheel for this Python version/platform (opencv-python-headless and sentencepiece
    // are common offenders on very new Python releases) the WHOLE command aborts, silently
    // skipping every package still queued after it - including huggingface_hub/diffusers
    // themselves, breaking core generation entirely, not just whatever the failing package was
    // for. Isolating each install call means one bad package can't take the others down with it.
    pushInstallLog("Installiere restliche Abhaengigkeiten (einzeln, damit ein einzelnes fehlschlagendes Paket nicht die anderen blockiert)...");
    const requirementLines = readFileSync(REQUIREMENTS_FILE, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    const CRITICAL_PACKAGES = new Set(["diffusers", "transformers"]);
    const failedCriticalPackages = [];
    for (const pkgSpec of requirementLines) {
      const pkgName = pkgSpec.split(/[<>=!~\[; ]/)[0].trim().toLowerCase();
      pushInstallLog(`Installiere ${pkgSpec}...`);
      try {
        await runInstallStep(venvPython, ["-m", "pip", "install", pkgSpec]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pushInstallLog(`Warnung: ${pkgSpec} konnte nicht installiert werden - ${message}`);
        if (CRITICAL_PACKAGES.has(pkgName)) failedCriticalPackages.push(pkgSpec);
      }
    }
    if (failedCriticalPackages.length) {
      throw new Error(`Kernabhaengigkeit(en) konnten nicht installiert werden: ${failedCriticalPackages.join(", ")} - siehe Log oben fuer die genaue Fehlermeldung.`);
    }

    install.phase = "done";
    pushInstallLog("Fertig - Videogenerierung ist einsatzbereit (Modellgewichte werden separat pro Modell geladen).");
  } catch (err) {
    install.phase = "error";
    install.error = err instanceof Error ? err.message : String(err);
    pushInstallLog(`Fehler: ${install.error}`);
    ctx.logger.error(`[video-gen install] ${install.error}`);
  }
}

const RUNNING_PHASES = new Set(["creating_venv", "installing_torch", "installing_deps"]);

// --- Model download (weights only, no inference) -------------------------------------------

/** Downloads a model's weights into the huggingface_hub cache WITHOUT loading it into a pipeline
 *  (no torch/diffusers pipeline construction, no GPU/CPU inference) - just huggingface_hub's
 *  snapshot_download, run as a one-off script in the plugin's venv. */
const DOWNLOAD_SCRIPT = `
import sys
from huggingface_hub import snapshot_download
repo_id = sys.argv[1]
token = sys.argv[2] or None
snapshot_download(repo_id=repo_id, token=token)
print("DOWNLOAD_OK")
`;

/** @type {{ key: string | null, phase: "idle"|"downloading"|"done"|"error", log: string[], error: string | null }} */
const modelDownload = { key: null, phase: "idle", log: [], error: null };

function pushDownloadLog(line) {
  modelDownload.log.push(line);
  if (modelDownload.log.length > INSTALL_LOG_MAX_LINES) modelDownload.log.splice(0, modelDownload.log.length - INSTALL_LOG_MAX_LINES);
}

async function runModelDownload(key, repoId, ctx) {
  modelDownload.key = key;
  modelDownload.phase = "downloading";
  modelDownload.error = null;
  modelDownload.log = [];
  try {
    pushDownloadLog(`Lade '${repoId}' herunter (kann bei Video-Modellen mehrere GB - teils 20+ GB - sein)...`);
    const hfToken = String(ctx.secrets.HF_TOKEN || "").trim();
    await runInstallStep(venvPythonPath(), ["-c", DOWNLOAD_SCRIPT, repoId, hfToken], pushDownloadLog);
    modelDownload.phase = "done";
    pushDownloadLog("Fertig heruntergeladen.");
  } catch (err) {
    modelDownload.phase = "error";
    modelDownload.error = explainSidecarError(err instanceof Error ? err.message : String(err));
    pushDownloadLog(`Fehler: ${modelDownload.error}`);
    ctx.logger.error(`[video-gen model download] ${modelDownload.error}`);
  }
}

function startModelDownload(input, ctx) {
  ensureVenvOrThrow(ctx);
  const key = String(input.model || "").trim();
  const repoId = MODEL_MAP[key];
  if (!repoId) throw new Error(`Unbekanntes Modell '${key}'`);
  if (modelDownload.phase === "downloading") {
    return { started: false, key: modelDownload.key, phase: modelDownload.phase };
  }
  // Fire and forget - the caller (UI) polls action=list_models for progress.
  void runModelDownload(key, repoId, ctx);
  return { started: true, key, phase: "downloading" };
}

function startInstall(ctx) {
  if (RUNNING_PHASES.has(install.phase)) {
    return { started: false, phase: install.phase };
  }
  // Fire and forget - the caller (agent or UI) polls action=status for progress.
  void runInstall(ctx);
  return { started: true, phase: install.phase };
}

function statusResult() {
  return {
    ready: hasVenv(),
    phase: install.phase,
    log: install.log.slice(-40),
    error: install.error,
  };
}

// --- Sidecar lifecycle -----------------------------------------------------------------------

async function waitForHealth(ctx, port) {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await ctx.fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // sidecar not listening yet, or still importing torch/diffusers - keep polling
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error("Videogenerierungs-Sidecar ist innerhalb des Timeouts nicht bereit geworden.");
}

function buildStartupError(stderrTail, code) {
  if (/ModuleNotFoundError|No module named/i.test(stderrTail)) {
    return new Error(
      "Die Python-Umgebung fuer die Videogenerierung ist noch nicht eingerichtet. Rufe action='install' auf, um sie automatisch einzurichten (Download mehrerer GB, dauert einige Minuten), und pruefe den Fortschritt mit action='status'."
    );
  }
  return new Error(`Sidecar-Prozess wurde unerwartet beendet (exit ${code}): ${stderrTail.slice(-500)}`);
}

function ensureSidecar(ctx) {
  if (sidecar.child && sidecar.ready) {
    return sidecar.ready.then(() => sidecar.port);
  }

  const ready = (async () => {
    const pythonPath = effectivePythonPath(ctx);
    const model = String(ctx.settings.VIDEO_MODEL || "cogvideox-2b");
    const device = String(ctx.settings.DEVICE || "auto");
    const maxIdleMinutes = Number(ctx.settings.MAX_IDLE_MINUTES ?? 10);
    const offline = Boolean(ctx.settings.OFFLINE_MODE);

    const port = await freePort();
    const args = [
      SERVER_SCRIPT,
      "--port", String(port),
      "--device", device,
      "--model", model,
      "--max-idle-seconds", String(Math.max(1, maxIdleMinutes) * 60),
    ];
    if (offline) args.push("--offline");

    const hfToken = String(ctx.secrets.HF_TOKEN || "").trim();
    const child = spawn(pythonPath, args, {
      cwd: PLUGIN_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: hfToken ? { ...process.env, HF_TOKEN: hfToken } : process.env,
    });

    let stderrTail = "";
    let settled = false;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
      ctx.logger.info(`[video-gen sidecar] ${chunk.trim()}`);
    });

    sidecar.child = child;
    sidecar.port = port;

    const exitPromise = new Promise((_resolveExit, rejectExit) => {
      child.on("exit", (code) => {
        if (sidecar.child === child) {
          sidecar.child = null;
          sidecar.port = null;
          sidecar.ready = null;
        }
        if (!settled) {
          settled = true;
          rejectExit(buildStartupError(stderrTail, code));
        }
      });
      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          rejectExit(err);
        }
      });
    });

    try {
      await Promise.race([waitForHealth(ctx, port), exitPromise]);
      settled = true;
      return port;
    } catch (err) {
      if (sidecar.child === child) {
        child.kill("SIGTERM");
        sidecar.child = null;
        sidecar.port = null;
        sidecar.ready = null;
      }
      throw err;
    }
  })();

  sidecar.ready = ready.then(() => undefined);
  return ready;
}

function stopSidecar() {
  if (sidecar.child) {
    sidecar.child.kill("SIGTERM");
  }
  sidecar.child = null;
  sidecar.port = null;
  sidecar.ready = null;
}

// --- Model cache (huggingface_hub) --------------------------------------------------------

/** Default huggingface_hub cache location, honoring the same env overrides huggingface_hub
 *  itself respects (HF_HOME / HUGGINGFACE_HUB_CACHE) - shared with image-gen and any other local
 *  HF tool, no plugin-specific override. */
function hfCacheDir() {
  if (process.env.HUGGINGFACE_HUB_CACHE) return process.env.HUGGINGFACE_HUB_CACHE;
  if (process.env.HF_HOME) return join(process.env.HF_HOME, "hub");
  return join(homedir(), ".cache", "huggingface", "hub");
}

function modelCacheDir(repoId) {
  return join(hfCacheDir(), "models--" + repoId.replace(/\//g, "--"));
}

function dirSizeBytes(dirPath) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dirPath, entry.name);
    try {
      if (entry.isSymbolicLink()) {
        total += statSync(full).size;
      } else if (entry.isDirectory()) {
        total += dirSizeBytes(full);
      } else {
        total += statSync(full).size;
      }
    } catch {
      // file vanished mid-walk or broken symlink - skip it
    }
  }
  return total;
}

/** Asks the running sidecar what it currently has loaded in memory. Returns null if no sidecar
 *  is running or it doesn't answer in time. */
async function currentlyLoadedModelKey(ctx) {
  if (!sidecar.child || !sidecar.port) return null;
  try {
    const res = await ctx.fetch(`http://127.0.0.1:${sidecar.port}/health`);
    if (!res.ok) return null;
    const body = await res.json();
    return body.model_loaded || null;
  } catch {
    return null;
  }
}

/** action=list_models: reports, per known model, whether its weights are downloaded (+ size) and
 *  whether it's the one currently loaded in the sidecar's memory. */
async function listModels(ctx) {
  const loadedKey = await currentlyLoadedModelKey(ctx);
  return {
    models: Object.entries(MODEL_MAP).map(([key, repoId]) => {
      const cacheDir = modelCacheDir(repoId);
      const downloaded = existsSync(cacheDir);
      return {
        key,
        repo_id: repoId,
        downloaded,
        size_bytes: downloaded ? dirSizeBytes(cacheDir) : 0,
        loaded: key === loadedKey,
        downloading: modelDownload.key === key && modelDownload.phase === "downloading",
        download_error: modelDownload.key === key && modelDownload.phase === "error" ? modelDownload.error : null,
      };
    }),
    engine_running: sidecar.child != null,
  };
}

/** action=uninstall_model: deletes a model's local weights from the huggingface_hub cache. */
async function uninstallModel(input, ctx) {
  const key = String(input.model || "").trim();
  const repoId = MODEL_MAP[key];
  if (!repoId) throw new Error(`Unbekanntes Modell '${key}'`);

  if (key === (await currentlyLoadedModelKey(ctx))) {
    stopSidecar();
  }

  const cacheDir = modelCacheDir(repoId);
  if (!existsSync(cacheDir)) {
    return { key, repo_id: repoId, uninstalled: false, reason: "not_downloaded" };
  }
  rmSync(cacheDir, { recursive: true, force: true });
  return { key, repo_id: repoId, uninstalled: true };
}

// --- Tool actions ------------------------------------------------------------------------

/** huggingface_hub reports an unauthenticated/rate-limited/gated request as a generic
 *  "not a valid model identifier" error instead of a clear 401/403 - this rewrites that specific
 *  case into an actionable message (several video models, e.g. HunyuanVideo, gate their repo). */
function explainSidecarError(rawError) {
  const message = String(rawError || "");
  if (/not a valid model identifier|is not a local folder|gated repo|access.*restricted/i.test(message)) {
    return `${message} — meist ein Huggingface-Auth-/Freigabe-Problem, kein Fehler im Modellnamen. Abhilfe: auf der Modellseite auf huggingface.co Zugriff beantragen/akzeptieren und ein Zugriffstoken (huggingface.co/settings/tokens) in der Plugin-Einstellung HF_TOKEN hinterlegen.`;
  }
  return message || null;
}

function ensureVenvOrThrow(ctx) {
  if (hasVenv()) return;
  if (ctx.settings.AUTO_INSTALL_DEPS) {
    const result = startInstall(ctx);
    throw new Error(
      result.started
        ? "Die Python-Umgebung wird gerade automatisch eingerichtet (Download mehrerer GB, dauert einige Minuten). Bitte mit action='status' den Fortschritt pruefen und die Aktion danach erneut versuchen."
        : `Einrichtung laeuft bereits (Phase: ${result.phase}). Bitte mit action='status' den Fortschritt pruefen und es gleich nochmal versuchen.`
    );
  }
  throw new Error(
    "Die Python-Umgebung ist noch nicht eingerichtet. Rufe action='install' auf, um sie automatisch einzurichten, und pruefe den Fortschritt mit action='status'."
  );
}

async function generate(input, ctx) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("prompt ist erforderlich");

  ensureVenvOrThrow(ctx);

  const port = await ensureSidecar(ctx);
  const res = await ctx.fetch(`http://127.0.0.1:${port}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      negative_prompt: input.negative_prompt,
      width: input.width,
      height: input.height,
      num_frames: input.num_frames,
      fps: input.fps,
      steps: input.steps,
      guidance_scale: input.guidance_scale,
      seed: input.seed,
      model: input.model || ctx.settings.VIDEO_MODEL || "cogvideox-2b",
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(explainSidecarError(body?.error) || `Sidecar-Fehler HTTP ${res.status}`);
  }

  const id = randomUUID();
  const buffer = Buffer.from(body.video_base64, "base64");
  mkdirSync(GENERATED_DIR, { recursive: true });
  writeFileSync(join(GENERATED_DIR, `${id}.mp4`), buffer);

  const storage = ctx.storage;
  await ensureSchema(storage);
  const createdAt = new Date().toISOString();
  await storage.exec(
    "INSERT INTO generations (id, prompt, negative_prompt, model, width, height, num_frames, fps, seed, file_path, created_at, steps, guidance_scale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, prompt, input.negative_prompt || null, body.model, body.width, body.height, body.num_frames, body.fps, body.seed ?? null, `generated/${id}.mp4`, createdAt, body.steps ?? null, body.guidance_scale ?? null]
  );

  return {
    id,
    prompt,
    negative_prompt: input.negative_prompt || null,
    model: body.model,
    seed: body.seed,
    steps: body.steps,
    guidance_scale: body.guidance_scale,
    width: body.width,
    height: body.height,
    num_frames: body.num_frames,
    fps: body.fps,
    duration_seconds: body.fps ? Math.round((body.num_frames / body.fps) * 10) / 10 : null,
    url: `/api/plugins/video-gen/data/generated/${id}.mp4`,
  };
}

async function list(input, ctx) {
  const storage = ctx.storage;
  await ensureSchema(storage);
  const limit = Math.min(Math.max(Number(input.limit || 24), 1), 100);
  const offset = Math.max(Number(input.offset || 0), 0);
  const [{ count }] = await storage.query("SELECT COUNT(*) as count FROM generations");
  const rows = await storage.query(
    "SELECT id, prompt, negative_prompt, model, width, height, num_frames, fps, seed, steps, guidance_scale, file_path, ai_analysis, created_at FROM generations ORDER BY created_at DESC LIMIT ? OFFSET ?",
    [limit, offset]
  );
  const items = rows.map((row) => ({
    ...row,
    duration_seconds: row.fps ? Math.round((row.num_frames / row.fps) * 10) / 10 : null,
    url: `/api/plugins/video-gen/data/${row.file_path}`,
  }));
  const total = Number(count) || 0;
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

/**
 * Actually LOOK at a generated clip via the app's active vision-capable model. No thumbnail is
 * cached at generation time (unlike image-gen's PNGs, extracting a frame needs ffmpeg/cv2 which
 * isn't guaranteed to be on PATH outside the plugin's own venv) - this action shells out to the
 * venv's own opencv-python install (a requirements.txt dependency already, needed for
 * export_to_video) to pull one middle frame as a PNG, base64-encoded, then hands that to
 * ctx.agent.analyzeImage exactly like image-gen's analyze does.
 */
async function analyzeGeneration(input, ctx) {
  if (!ctx.agent) {
    throw new Error("Agent-Capabilities (analyzeImage) sind in diesem Kontext nicht verfuegbar.");
  }
  const id = String(input.id || "").trim();
  if (!id) throw new Error("id ist erforderlich (siehe generate/list)");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Ungueltige id");

  const storage = ctx.storage;
  await ensureSchema(storage);
  const rows = await storage.query("SELECT id, prompt, file_path FROM generations WHERE id = ?", [id]);
  const row = rows[0];
  if (!row) throw new Error(`Kein generierter Clip mit id '${id}' gefunden`);

  if (!hasVenv()) {
    throw new Error("Die Python-Umgebung ist noch nicht eingerichtet (action='install'), kann daher keinen Frame extrahieren.");
  }

  const videoPath = join(PLUGIN_DIR, "data", row.file_path);
  const extractScript = `
import sys, cv2, base64
cap = cv2.VideoCapture(sys.argv[1])
frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
cap.set(cv2.CAP_PROP_POS_FRAMES, frame_count // 2)
ok, frame = cap.read()
if not ok:
    ok, frame = cap.read()
if not ok:
    raise SystemExit("could not read a frame")
ok, buf = cv2.imencode(".png", frame)
sys.stdout.write(base64.b64encode(buf.tobytes()).decode("ascii"))
`;
  const base64Png = await new Promise((resolveFrame, rejectFrame) => {
    const child = spawn(venvPythonPath(), ["-c", extractScript, videoPath], { cwd: PLUGIN_DIR, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { err += chunk.toString("utf8"); });
    child.on("error", rejectFrame);
    child.on("exit", (code) => {
      if (code === 0 && out.trim()) resolveFrame(out.trim());
      else rejectFrame(new Error(`Frame-Extraktion fehlgeschlagen: ${err.slice(-500) || `exit ${code}`}`));
    });
  });

  const question = String(input.question || "").trim() ||
    `Beschreibe diesen Frame aus einem generierten Video kurz und pruefe, ob er zu folgendem Prompt passt: "${row.prompt}". Weise auf deutliche Fehler/Artefakte hin, falls vorhanden.`;

  const analysis = await ctx.agent.analyzeImage([{ base64: `data:image/png;base64,${base64Png}` }], question);
  await storage.exec("UPDATE generations SET ai_analysis = ? WHERE id = ?", [analysis, id]);
  return { id, prompt: row.prompt, analysis };
}

const SUGGEST_PROMPT_INSTRUCTION =
  "You help draft prompts for a text-to-video diffusion model. Take the user's rough idea (in any " +
  "language) and expand it into ONE detailed, well-structured ENGLISH video-generation prompt - " +
  "describe concrete MOTION/ACTION (camera movement, subject movement, how the scene evolves over " +
  "time), not just a static scene description, plus style/lighting/mood. Also suggest a short " +
  "English negative_prompt (things to avoid, e.g. 'static, blurry, distorted motion, low quality'). " +
  "Respond with ONLY a single JSON object, no other text: " +
  '{"prompt": "...", "negative_prompt": "..."}';

function parseSuggestedPrompt(rawText, idea) {
  const match = /\{[\s\S]*\}/.exec(rawText || "");
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed.prompt === "string" && parsed.prompt.trim()) {
        return {
          prompt: parsed.prompt.trim(),
          negative_prompt: typeof parsed.negative_prompt === "string" ? parsed.negative_prompt.trim() : "",
        };
      }
    } catch {
      // fall through to the raw-text fallback below
    }
  }
  return { prompt: (rawText || idea || "").trim(), negative_prompt: "" };
}

async function suggestPrompt(input, ctx) {
  if (!ctx.agent) {
    throw new Error("Agent-Capabilities (analyzeText) sind in diesem Kontext nicht verfuegbar.");
  }
  const idea = String(input.idea || "").trim();
  if (!idea) throw new Error("idea ist erforderlich");

  const rawText = await ctx.agent.analyzeText(idea, SUGGEST_PROMPT_INSTRUCTION);
  return parseSuggestedPrompt(rawText, idea);
}

async function deleteGeneration(input, ctx) {
  const id = String(input.id || "").trim();
  if (!id) throw new Error("id ist erforderlich");

  const storage = ctx.storage;
  await ensureSchema(storage);
  const rows = await storage.query("SELECT file_path FROM generations WHERE id = ?", [id]);
  const row = rows[0];
  if (!row) throw new Error(`Kein generierter Clip mit id '${id}' gefunden`);

  try {
    unlinkSync(join(PLUGIN_DIR, "data", row.file_path));
  } catch {
    // file already gone - deleting the DB row is still the right outcome
  }
  await storage.exec("DELETE FROM generations WHERE id = ?", [id]);
  return { id, deleted: true };
}

export async function execute(input, ctx) {
  const action = input.action;
  if (action === "generate") return generate(input, ctx);
  if (action === "list") return list(input, ctx);
  if (action === "analyze") return analyzeGeneration(input, ctx);
  if (action === "suggest_prompt") return suggestPrompt(input, ctx);
  if (action === "delete") return deleteGeneration(input, ctx);
  if (action === "install") return startInstall(ctx);
  if (action === "status") return statusResult();
  if (action === "stop_engine") {
    stopSidecar();
    return { stopped: true };
  }
  if (action === "list_models") return listModels(ctx);
  if (action === "unload_model") {
    const wasRunning = sidecar.child != null;
    stopSidecar();
    return { unloaded: wasRunning };
  }
  if (action === "uninstall_model") return uninstallModel(input, ctx);
  if (action === "install_model") return startModelDownload(input, ctx);
  throw new Error(`Unbekannte action: ${action}`);
}
