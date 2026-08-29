/**
 * Local image generation (trust: "node"). Spawns a Python sidecar (runtime/server.py, using
 * the `diffusers` library) on first use, talks to it over plain HTTP on 127.0.0.1, and stores
 * generated PNGs under this plugin's OWN data/ folder + metadata in its OWN SQLite - same
 * base64-in/data-route-out convention video-editor uses for media (see
 * plugins/video-editor/tools/video-editor.js).
 *
 * SETUP: rather than requiring the user to run pip commands by hand, this module can also
 * install its own Python environment (action=install): creates runtime/.venv, installs a
 * CUDA build of torch if an NVIDIA GPU is detected (falls back to CPU), then the rest of
 * runtime/requirements.txt. Progress is polled via action=status (no generic SSE/WS channel
 * exists for plugins in this repo, see plugins.ts) - the frontend (app/index.html) and/or the
 * agent (per skills/image-gen-usage/SKILL.md) drive this: on a "not set up yet" error, call
 * action=install, poll action=status until ready, then retry action=generate. Once runtime/.venv
 * exists it is used automatically - no PYTHON_PATH setting needs to be touched by the user.
 *
 * No sharp/image-resize dependency exists anywhere in this repo (video-editor's doc comment
 * notes it deliberately avoids adding one), so no separate downscaled thumbnail is generated:
 * the full PNG is returned as a data URL in the tool result only while it stays small enough
 * for a chat message (see THUMBNAIL_MAX_BYTES below); otherwise only the /data/* file URL is
 * returned and the UI/agent fetches bytes from there.
 *
 * The sidecar process itself is a singleton per Node process (module-level state, mirroring
 * ensureDetectorWorker() in plugins/vision-analyzer/tools/vision.js) and exits itself after an
 * idle timeout (passed as --max-idle-seconds), so no explicit reap loop is needed here beyond
 * the optional stop_engine action.
 *
 * ANALYSIS: a tool result's data: URL is just inert text to the top-level agent loop - nothing
 * in packages/agent/src/agent.ts promotes it to a real multimodal image block (that only
 * happens for the hardcoded browser-screenshot path). So "the agent can see the image it just
 * generated" requires an explicit action=analyze that calls ctx.agent.analyzeImage([...], question)
 * itself (same mechanism as analyze_clip in video-editor/tools/video-editor.js and analyzeFrame in
 * vision-analyzer/tools/vision.js) and returns the description as TEXT in the tool result, which
 * the agent then reads normally on its next turn. No extra `permissions` entry is needed for this -
 * analyzeImage/analyzeVideo/analyzeText are ungated for any trust:"node" plugin, only
 * ctx.agent.browser is permission-gated (browser.frames).
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const GENERATED_DIR = join(PLUGIN_DIR, "data", "generated");
const SERVER_SCRIPT = join(PLUGIN_DIR, "runtime", "server.py");
const REQUIREMENTS_FILE = join(PLUGIN_DIR, "runtime", "requirements.txt");
const VENV_DIR = join(PLUGIN_DIR, "runtime", ".venv");

const HEALTH_POLL_INTERVAL_MS = 1000;
const HEALTH_POLL_TIMEOUT_MS = 90_000; // cold start can include a multi-GB model load
const THUMBNAIL_MAX_BYTES = 300 * 1024;
const INSTALL_LOG_MAX_LINES = 300;

/** @type {{ child: import("node:child_process").ChildProcess | null, port: number | null, ready: Promise<void> | null }} */
const sidecar = { child: null, port: null, ready: null };

/** @type {{ phase: "idle"|"creating_venv"|"installing_torch"|"installing_deps"|"done"|"error", log: string[], error: string | null }} */
const install = { phase: "idle", log: [], error: null };

export const definition = {
  name: "image_gen",
  description:
    "Generiert Bilder/Thumbnails lokal mit einem kleinen Diffusionsmodell (SD-Turbo, SDXL-Turbo oder Flux-1-schnell), ueber einen eigenen Python-Sidecar - keine Cloud, keine fremde Oberflaeche. " +
    "action=generate (prompt, negative_prompt?, width?, height?, steps?, guidance_scale?, seed?, model?) erzeugt ein Bild und liefert eine Datei-URL (und bei kleinen Bildern eine Vorschau als Data-URL) zurueck. " +
    "guidance_scale (CFG) steuert wie strikt sich das Modell an den Prompt haelt (0 = ignoriert Prompt-Staerke komplett, ~7-9 typisch fuer klassische SD-Modelle) - Turbo-/Schnell-Modelle sind aber auf 0 trainiert und werden mit hoeheren Werten meist SCHLECHTER statt besser, also nur gezielt zum Experimentieren aendern. " +
    "action=generate_preview (gleiche Parameter wie generate) erzeugt ein Bild GENAU WIE generate, speichert es aber NICHT (keine Datei, kein Datenbankeintrag) - liefert stattdessen image_data_url direkt zurueck. Fuer den Live-Modus der Oberflaeche gedacht (schnelles Durchprobieren), fuer dich als Agent i.d.R. nicht relevant - nutze normalerweise generate. " +
    "action=save_generation (prompt, image_base64, negative_prompt?, width?, height?, seed?, model?, steps?, guidance_scale?, reference_id?) speichert ein zuvor per generate_preview erzeugtes Bild nachtraeglich (Datei + Datenbankeintrag), OHNE es neu zu generieren - image_base64 ist die image_data_url aus generate_preview. " +
    "Mit reference_id (id eines frueheren eigenen generate-Ergebnisses) ODER reference_image (Base64/Data-URL) wird das Bild NICHT neu erzeugt, sondern das Referenzbild per img2img veraendert (guided von prompt) - strength (0-1, Standard 0.6) steuert wie stark; nutze das fuer Stil-/Charakter-Konsistenz ueber mehrere Bilder (z. B. Slideshow-Frames). " +
    "action=list (limit?, offset?) listet zuletzt erzeugte Bilder (inkl. vorheriger Analysen, falls vorhanden), paginiert - liefert {items, total, limit, offset, hasMore}. " +
    "action=analyze (id, question?) laesst dich das erzeugte Bild TATSAECHLICH ansehen (Vision-Modell) - nutze es, um zu pruefen ob das Ergebnis zum Prompt passt, Text im Bild lesbar ist, oder um es fuer den Nutzer zu beschreiben. Ohne diese Action siehst du das Bild NICHT, nur eine URL. " +
    "action=suggest_prompt (idea) baut aus einer groben Idee per LLM einen ausformulierten Bildgenerierungs-Prompt (+ Vorschlaege fuer negative_prompt/width/height). " +
    "action=delete (id) loescht ein generiertes Bild dauerhaft (Datei + Datenbankeintrag). " +
    "action=upscale (id, scale?) vergroessert ein Bild (Lanczos-Resize, scale 1-4, Standard 2) - reines Bildverfahren, KEIN KI-Modell, kein Download, funktioniert sofort. " +
    "action=sharpen (id, sharpen_amount?) schaerft ein Bild nach (Unsharp-Mask, sharpen_amount 0-300, Standard 150) - ebenfalls kein KI-Modell. Beide legen ein NEUES Bild an (verweist per reference_id auf das Original), das Original bleibt erhalten. " +
    "action=install richtet die Python-Umgebung automatisch ein (venv + PyTorch/diffusers, GPU wird automatisch erkannt) - beim ersten Mal noetig, dauert mehrere Minuten. " +
    "action=status liefert den Einrichtungsfortschritt (ready, phase, log). " +
    "action=stop_engine beendet den lokalen Sidecar-Prozess sofort (sonst beendet er sich nach Leerlauf selbst).",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["generate", "generate_preview", "save_generation", "list", "analyze", "suggest_prompt", "delete", "upscale", "sharpen", "install", "status", "stop_engine"], description: "Welche Operation ausgefuehrt wird" },
      prompt: { type: "string", description: "Bildbeschreibung (Englisch funktioniert meist am besten)" },
      negative_prompt: { type: "string", description: "Was im Bild vermieden werden soll (wird von Turbo-Modellen ggf. ignoriert)" },
      width: { type: "number", description: "Breite in Pixeln, Standard 512" },
      height: { type: "number", description: "Hoehe in Pixeln, Standard 512" },
      steps: { type: "number", description: "Anzahl Diffusionsschritte, Standard modellabhaengig (1-4 fuer Turbo/Schnell-Modelle). Mehr Schritte = i.d.R. mehr Detail, aber langsamer; bei Turbo/Schnell-Modellen bringt weit ueber den Standard hinausgehen kaum noch etwas." },
      guidance_scale: { type: "number", description: "CFG-Wert (Classifier-Free Guidance), Standard modellabhaengig (0 fuer Turbo/Schnell-Modelle). Hoeher = folgt dem Prompt staerker (und beruecksichtigt negative_prompt), kann aber uebersaettigt/verzerrt wirken - bei Turbo/Schnell-Modellen macht ein Wert > 0 die Bilder meist schlechter, nicht besser." },
      seed: { type: "number", description: "Fester Seed fuer reproduzierbare Ergebnisse" },
      model: { type: "string", enum: ["sd-turbo", "sdxl-turbo", "flux-schnell"], description: "Modell-Override fuer diese eine Generierung (sonst Plugin-Einstellung IMAGE_MODEL)" },
      reference_id: { type: "string", description: "id eines frueheren image_gen-Ergebnisses als img2img-Referenzbild (bevorzugt gegenueber reference_image - kein Base64 durch den Kontext schleusen)" },
      reference_image: { type: "string", description: "Referenzbild als Base64/Data-URL fuer img2img, falls es NICHT von einem frueheren image_gen-Aufruf stammt (reference_id ist meist die bessere Wahl)" },
      strength: { type: "number", description: "img2img-Staerke 0-1 (nur mit reference_id/reference_image), Standard 0.6 - hoeher = staerkere Veraenderung des Referenzbilds" },
      limit: { type: "number", description: "Max. Anzahl Ergebnisse fuer action=list, Standard 24" },
      offset: { type: "number", description: "Anzahl zu ueberspringender Ergebnisse fuer action=list (Pagination), Standard 0" },
      id: { type: "string", description: "ID des erzeugten Bildes fuer action=analyze/delete/upscale/sharpen (aus generate/list)" },
      question: { type: "string", description: "Konkrete Frage ans Vision-Modell fuer action=analyze, z. B. 'Ist der Text im Bild lesbar?' (Standard: allgemeine Beschreibung + Prompt-Abgleich)" },
      idea: { type: "string", description: "Grobe, auch unvollstaendige Idee fuer action=suggest_prompt, z. B. 'katze am fenster'" },
      image_base64: { type: "string", description: "Bild als Base64/Data-URL fuer action=save_generation (aus generate_preview's image_data_url)" },
      scale: { type: "number", description: "Vergroesserungsfaktor fuer action=upscale, 1-4, Standard 2" },
      sharpen_amount: { type: "number", description: "Schaerfe-Staerke fuer action=sharpen, 0-300, Standard 150" },
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
      "seed INTEGER, " +
      "file_path TEXT NOT NULL, " +
      "thumbnail_data_url TEXT, " +
      "created_at TEXT NOT NULL" +
      ")"
  );
  // Additive migrations for databases created before these columns existed.
  try { await storage.exec("ALTER TABLE generations ADD COLUMN ai_analysis TEXT"); } catch { /* already exists */ }
  try { await storage.exec("ALTER TABLE generations ADD COLUMN reference_id TEXT"); } catch { /* already exists */ }
  try { await storage.exec("ALTER TABLE generations ADD COLUMN steps INTEGER"); } catch { /* already exists */ }
  try { await storage.exec("ALTER TABLE generations ADD COLUMN guidance_scale REAL"); } catch { /* already exists */ }
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

function runInstallStep(command, args) {
  return new Promise((resolveStep, rejectStep) => {
    const child = spawn(command, args, { cwd: PLUGIN_DIR, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    const onData = (chunk) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) pushInstallLog(line.trim());
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", rejectStep);
    child.on("exit", (code) => {
      if (code === 0) resolveStep();
      else rejectStep(new Error(`Befehl fehlgeschlagen (exit ${code}): ${command} ${args.join(" ")}`));
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
      pushInstallLog("Keine NVIDIA-GPU erkannt (oder DEVICE=cpu) - installiere PyTorch (CPU)...");
      await runInstallStep(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
      await runInstallStep(venvPython, ["-m", "pip", "install", "torch"]);
    }

    install.phase = "installing_deps";
    pushInstallLog("Installiere restliche Abhaengigkeiten (diffusers, transformers, accelerate, safetensors, pillow)...");
    await runInstallStep(venvPython, ["-m", "pip", "install", "-r", REQUIREMENTS_FILE]);

    install.phase = "done";
    pushInstallLog("Fertig - Bildgenerierung ist einsatzbereit.");
  } catch (err) {
    install.phase = "error";
    install.error = err instanceof Error ? err.message : String(err);
    pushInstallLog(`Fehler: ${install.error}`);
    ctx.logger.error(`[image-gen install] ${install.error}`);
  }
}

const RUNNING_PHASES = new Set(["creating_venv", "installing_torch", "installing_deps"]);

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
  throw new Error("Bildgenerierungs-Sidecar ist innerhalb des Timeouts nicht bereit geworden.");
}

function buildStartupError(stderrTail, code) {
  if (/ModuleNotFoundError|No module named/i.test(stderrTail)) {
    return new Error(
      "Die Python-Umgebung fuer die Bildgenerierung ist noch nicht eingerichtet. Rufe action='install' auf, um sie automatisch einzurichten (Download mehrerer GB, dauert einige Minuten), und pruefe den Fortschritt mit action='status'."
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
    const model = String(ctx.settings.IMAGE_MODEL || "sd-turbo");
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
      // huggingface_hub reads HF_TOKEN from the environment automatically - some repos (e.g.
      // Flux-1-schnell) return a generic "not a valid model identifier" error for unauthenticated
      // requests instead of a clear 401, so this is the fix for that specific error message.
      env: hfToken ? { ...process.env, HF_TOKEN: hfToken } : process.env,
    });

    let stderrTail = "";
    let settled = false;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
      ctx.logger.info(`[image-gen sidecar] ${chunk.trim()}`);
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

// --- Tool actions ------------------------------------------------------------------------

function stripDataUrlPrefix(value) {
  const match = /^data:[^;]+;base64,(.+)$/s.exec(value);
  return match ? match[1] : value;
}

/** Resolves the img2img reference image, either from a previous OWN generation (reference_id -
 *  read straight from disk, no re-encoding round-trip through the caller) or an inline base64/
 *  data-URL string (reference_image). */
async function resolveReferenceImageBase64(input, ctx) {
  if (input.reference_id) {
    const id = String(input.reference_id).trim();
    const storage = ctx.storage;
    await ensureSchema(storage);
    const rows = await storage.query("SELECT file_path FROM generations WHERE id = ?", [id]);
    const row = rows[0];
    if (!row) throw new Error(`reference_id '${id}' nicht gefunden`);
    const buffer = readFileSync(join(PLUGIN_DIR, "data", row.file_path));
    return buffer.toString("base64");
  }
  if (input.reference_image) {
    return stripDataUrlPrefix(String(input.reference_image));
  }
  return null;
}

/** huggingface_hub reports an unauthenticated/rate-limited request against some repos (observed
 *  with black-forest-labs/FLUX.1-schnell) as a generic "not a valid model identifier" error
 *  instead of a clear 401 - this rewrites that specific case into an actionable message instead
 *  of leaving the user to guess. */
function explainSidecarError(rawError) {
  const message = String(rawError || "");
  if (/not a valid model identifier|is not a local folder/i.test(message)) {
    return `${message} — meist ein Huggingface-Auth-/Rate-Limit-Problem, kein Fehler im Modellnamen. Abhilfe: ein Hugging-Face-Zugriffstoken (huggingface.co/settings/tokens) in der Plugin-Einstellung HF_TOKEN hinterlegen.`;
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

/** Runs the actual diffusion call against the sidecar (shared by generate + generate_preview) -
 *  does NOT touch disk or the database, just returns the sidecar's raw response body. */
async function callSidecarGenerate(prompt, input, ctx) {
  ensureVenvOrThrow(ctx);

  const referenceImageBase64 = await resolveReferenceImageBase64(input, ctx);

  const port = await ensureSidecar(ctx);
  const res = await ctx.fetch(`http://127.0.0.1:${port}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      negative_prompt: input.negative_prompt,
      width: input.width,
      height: input.height,
      steps: input.steps,
      guidance_scale: input.guidance_scale,
      seed: input.seed,
      model: input.model || ctx.settings.IMAGE_MODEL || "sd-turbo",
      reference_image_base64: referenceImageBase64,
      strength: input.strength,
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(explainSidecarError(body?.error) || `Sidecar-Fehler HTTP ${res.status}`);
  }
  return body;
}

/** Writes the PNG to disk and inserts the DB row - shared by generate (fresh sidecar call) and
 *  save_generation (persisting a previously shown, not-yet-saved Live-Modus preview). */
async function persistGeneration({ prompt, negativePrompt, referenceId, width, height, imageBase64, seed, model, steps, guidanceScale }, ctx) {
  const id = randomUUID();
  const buffer = Buffer.from(imageBase64, "base64");
  mkdirSync(GENERATED_DIR, { recursive: true });
  writeFileSync(join(GENERATED_DIR, `${id}.png`), buffer);

  const thumbnailDataUrl = buffer.byteLength <= THUMBNAIL_MAX_BYTES
    ? `data:image/png;base64,${imageBase64}`
    : null;

  const storage = ctx.storage;
  await ensureSchema(storage);
  const createdAt = new Date().toISOString();
  await storage.exec(
    "INSERT INTO generations (id, prompt, negative_prompt, model, width, height, seed, file_path, thumbnail_data_url, created_at, reference_id, steps, guidance_scale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, prompt, negativePrompt || null, model, width, height, seed ?? null, `generated/${id}.png`, thumbnailDataUrl, createdAt, referenceId || null, steps ?? null, guidanceScale ?? null]
  );

  return {
    id,
    prompt,
    negative_prompt: negativePrompt || null,
    model,
    seed,
    steps,
    guidance_scale: guidanceScale,
    width,
    height,
    url: `/api/plugins/image-gen/data/generated/${id}.png`,
    thumbnail_data_url: thumbnailDataUrl,
  };
}

async function generate(input, ctx) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("prompt ist erforderlich");

  const body = await callSidecarGenerate(prompt, input, ctx);
  const width = Number(input.width || 512);
  const height = Number(input.height || 512);

  return persistGeneration({
    prompt,
    negativePrompt: input.negative_prompt,
    referenceId: input.reference_id,
    width,
    height,
    imageBase64: body.image_base64,
    seed: body.seed,
    model: body.model,
    steps: body.steps,
    guidanceScale: body.guidance_scale,
  }, ctx);
}

/**
 * Live-Modus: runs the exact same diffusion call as generate(), but never touches disk or the
 * database - the frontend debounces prompt/setting changes and calls this on every change so the
 * user sees a live-updating result while typing, without flooding the gallery with intermediate
 * throwaway images. Returns the full image as a data URL (no THUMBNAIL_MAX_BYTES cutoff, since
 * there's no persisted file to fall back to) plus every value save_generation needs to persist
 * this exact result later without re-running the diffusion model.
 */
async function generatePreview(input, ctx) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("prompt ist erforderlich");

  const body = await callSidecarGenerate(prompt, input, ctx);
  const width = Number(input.width || 512);
  const height = Number(input.height || 512);

  return {
    prompt,
    negative_prompt: input.negative_prompt || null,
    model: body.model,
    seed: body.seed,
    steps: body.steps,
    guidance_scale: body.guidance_scale,
    width,
    height,
    image_data_url: `data:image/png;base64,${body.image_base64}`,
  };
}

/**
 * Persists a Live-Modus preview the user liked, WITHOUT re-running the diffusion model - takes
 * the exact image_data_url + settings a prior generate_preview call returned and writes them to
 * disk/DB, same shape as a normal generate() result.
 */
async function saveGeneration(input, ctx) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("prompt ist erforderlich");
  const imageBase64 = stripDataUrlPrefix(String(input.image_base64 || ""));
  if (!imageBase64) throw new Error("image_base64 ist erforderlich (aus generate_preview)");

  return persistGeneration({
    prompt,
    negativePrompt: input.negative_prompt,
    referenceId: input.reference_id,
    width: Number(input.width || 512),
    height: Number(input.height || 512),
    imageBase64,
    seed: input.seed,
    model: input.model,
    steps: input.steps,
    guidanceScale: input.guidance_scale,
  }, ctx);
}

async function list(input, ctx) {
  const storage = ctx.storage;
  await ensureSchema(storage);
  const limit = Math.min(Math.max(Number(input.limit || 24), 1), 100);
  const offset = Math.max(Number(input.offset || 0), 0);
  const [{ count }] = await storage.query("SELECT COUNT(*) as count FROM generations");
  const rows = await storage.query(
    "SELECT id, prompt, negative_prompt, model, width, height, seed, steps, guidance_scale, file_path, thumbnail_data_url, ai_analysis, reference_id, created_at FROM generations ORDER BY created_at DESC LIMIT ? OFFSET ?",
    [limit, offset]
  );
  const items = rows.map((row) => ({
    ...row,
    url: `/api/plugins/image-gen/data/${row.file_path}`,
  }));
  const total = Number(count) || 0;
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

/**
 * Actually LOOK at a generated image via the app's active vision-capable model
 * (ctx.agent.analyzeImage - see the module doc comment for why this is necessary at all).
 * Reuses the cached thumbnail_data_url when available (already the right base64 payload
 * shape for AgentImageInput.base64); falls back to reading the full PNG from disk for
 * larger images that didn't get a thumbnail. Caches the result in ai_analysis so repeated
 * action=list calls don't need to re-run vision analysis.
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
  const rows = await storage.query(
    "SELECT id, prompt, model, file_path, thumbnail_data_url FROM generations WHERE id = ?",
    [id]
  );
  const row = rows[0];
  if (!row) throw new Error(`Kein generiertes Bild mit id '${id}' gefunden`);

  const base64 = row.thumbnail_data_url || (() => {
    const buffer = readFileSync(join(PLUGIN_DIR, "data", row.file_path));
    return `data:image/png;base64,${buffer.toString("base64")}`;
  })();

  const question = String(input.question || "").trim() ||
    `Beschreibe dieses generierte Bild kurz und pruefe, ob es zu folgendem Prompt passt: "${row.prompt}". Weise auf verzerrten/unleserlichen Text oder deutliche Fehler hin, falls vorhanden.`;

  const analysis = await ctx.agent.analyzeImage([{ base64 }], question);

  await storage.exec("UPDATE generations SET ai_analysis = ? WHERE id = ?", [analysis, id]);

  return { id, prompt: row.prompt, analysis };
}

/**
 * Upscale/sharpen an existing generation via the sidecar's /enhance endpoint - plain PIL
 * (Lanczos resize + UnsharpMask), NOT a learned super-resolution model: no extra model download,
 * works even before the diffusion pipeline itself has ever been loaded. Saves the result as a
 * NEW generation (reference_id = source id), so the chain shows up in the detail view exactly
 * like an img2img variant does.
 */
async function enhanceGeneration(input, ctx, kind) {
  const id = String(input.id || "").trim();
  if (!id) throw new Error("id ist erforderlich (siehe generate/list)");

  ensureVenvOrThrow(ctx);

  const storage = ctx.storage;
  await ensureSchema(storage);
  const rows = await storage.query("SELECT prompt, model, file_path FROM generations WHERE id = ?", [id]);
  const row = rows[0];
  if (!row) throw new Error(`Kein generiertes Bild mit id '${id}' gefunden`);

  const sourceBuffer = readFileSync(join(PLUGIN_DIR, "data", row.file_path));
  const port = await ensureSidecar(ctx);
  const res = await ctx.fetch(`http://127.0.0.1:${port}/enhance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_base64: sourceBuffer.toString("base64"),
      action: kind,
      scale: input.scale,
      sharpen_amount: input.sharpen_amount,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `Sidecar-Fehler HTTP ${res.status}`);

  const newId = randomUUID();
  const newBuffer = Buffer.from(body.image_base64, "base64");
  mkdirSync(GENERATED_DIR, { recursive: true });
  writeFileSync(join(GENERATED_DIR, `${newId}.png`), newBuffer);

  const thumbnailDataUrl = newBuffer.byteLength <= THUMBNAIL_MAX_BYTES
    ? `data:image/png;base64,${body.image_base64}`
    : null;
  const createdAt = new Date().toISOString();
  await storage.exec(
    "INSERT INTO generations (id, prompt, negative_prompt, model, width, height, seed, file_path, thumbnail_data_url, created_at, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [newId, row.prompt, null, row.model, body.width, body.height, null, `generated/${newId}.png`, thumbnailDataUrl, createdAt, id]
  );

  return {
    id: newId,
    prompt: row.prompt,
    width: body.width,
    height: body.height,
    url: `/api/plugins/image-gen/data/generated/${newId}.png`,
    thumbnail_data_url: thumbnailDataUrl,
  };
}

const SUGGEST_PROMPT_INSTRUCTION =
  "You help draft prompts for a text-to-image diffusion model. Take the user's rough idea (in any " +
  "language) and expand it into ONE detailed, well-structured ENGLISH image-generation prompt " +
  "(style, composition, lighting, mood - concrete visual details, not vague adjectives). Also " +
  "suggest a short English negative_prompt (things to avoid), and a sensible width/height in " +
  "pixels (both multiples of 64, default 512x512 unless the idea clearly implies a different " +
  "aspect ratio, e.g. a 16:9 thumbnail). Respond with ONLY a single JSON object, no other text: " +
  '{"prompt": "...", "negative_prompt": "...", "width": 512, "height": 512}';

/** Extracts the first {...} block from free-form LLM text and parses it; never throws - falls
 *  back to using the raw text as the prompt itself if the model didn't return valid JSON. */
function parseSuggestedPrompt(rawText, idea) {
  const match = /\{[\s\S]*\}/.exec(rawText || "");
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed.prompt === "string" && parsed.prompt.trim()) {
        return {
          prompt: parsed.prompt.trim(),
          negative_prompt: typeof parsed.negative_prompt === "string" ? parsed.negative_prompt.trim() : "",
          width: Number.isFinite(Number(parsed.width)) ? Number(parsed.width) : 512,
          height: Number.isFinite(Number(parsed.height)) ? Number(parsed.height) : 512,
        };
      }
    } catch {
      // fall through to the raw-text fallback below
    }
  }
  return { prompt: (rawText || idea || "").trim(), negative_prompt: "", width: 512, height: 512 };
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
  if (!row) throw new Error(`Kein generiertes Bild mit id '${id}' gefunden`);

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
  if (action === "generate_preview") return generatePreview(input, ctx);
  if (action === "save_generation") return saveGeneration(input, ctx);
  if (action === "list") return list(input, ctx);
  if (action === "analyze") return analyzeGeneration(input, ctx);
  if (action === "suggest_prompt") return suggestPrompt(input, ctx);
  if (action === "delete") return deleteGeneration(input, ctx);
  if (action === "upscale") return enhanceGeneration(input, ctx, "upscale");
  if (action === "sharpen") return enhanceGeneration(input, ctx, "sharpen");
  if (action === "install") return startInstall(ctx);
  if (action === "status") return statusResult();
  if (action === "stop_engine") {
    stopSidecar();
    return { stopped: true };
  }
  throw new Error(`Unbekannte action: ${action}`);
}
