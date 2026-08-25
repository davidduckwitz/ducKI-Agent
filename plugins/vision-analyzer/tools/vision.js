import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const sessions = new Map();
let ocrWorkerPromise = null;

const DEPENDENCY_PACKS = {
  ocr: {
    id: "ocr",
    label: "Lokales OCR (Deutsch)",
    description: "Texterkennung komplett lokal mit Tesseract.js und lokal installiertem deutschem Sprachmodell.",
    packages: ["tesseract.js@7.0.0", "@tesseract.js-data/deu@1.0.0"],
    probes: ["tesseract.js", "@tesseract.js-data/deu"],
  },
  onnx: {
    id: "onnx",
    label: "Local Vision Runtime",
    description: "ONNX Runtime + Sharp als lokale Basis für YOLO/Object Detection. Kein Modell wird automatisch ausgeführt.",
    packages: ["onnxruntime-node@1.29.0", "sharp@0.35.3"],
    probes: ["onnxruntime-node", "sharp"],
  },
};

function isInstalled(moduleName) {
  try {
    require.resolve(moduleName);
    return true;
  } catch {
    return false;
  }
}

function dependencyStatus() {
  const packs = Object.values(DEPENDENCY_PACKS).map((pack) => ({
    id: pack.id,
    label: pack.label,
    description: pack.description,
    installed: pack.probes.every(isInstalled),
    modules: pack.probes.map((name) => ({ name, installed: isInstalled(name) })),
  }));
  return {
    zeroDependency: {
      installed: true,
      features: ["browser-stream", "qr-code", "motion-detection"],
      description: "Funktioniert ohne zusätzliche Node-Pakete und ohne LLM.",
    },
    packs,
  };
}

function packFor(id) {
  const pack = DEPENDENCY_PACKS[id];
  if (!pack) throw new Error(`Unknown dependency pack '${id}'`);
  return pack;
}

async function runNpm(args) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    const result = await execFileAsync(command, args, {
      cwd: pluginRoot,
      timeout: 5 * 60 * 1000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      shell: process.platform === "win32",
    });
    return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  } catch (error) {
    const detail = error?.stderr || error?.stdout || error?.message || String(error);
    throw new Error(`Dependency installation failed: ${String(detail).slice(0, 2000)}`);
  }
}

async function installPack(id) {
  const pack = packFor(id);
  if (pack.probes.every(isInstalled)) return { changed: false, status: dependencyStatus() };
  const output = await runNpm(["install", "--no-save", "--package-lock=false", "--no-audit", "--no-fund", ...pack.packages]);
  return { changed: true, output: output.slice(-2000), status: dependencyStatus() };
}

async function removePack(id) {
  const pack = packFor(id);
  if (!pack.probes.some(isInstalled)) return { changed: false, status: dependencyStatus() };
  if (id === "ocr" && ocrWorkerPromise) {
    try { (await ocrWorkerPromise)?.terminate?.(); } catch {}
    ocrWorkerPromise = null;
  }
  const names = pack.packages.map((entry) => entry.replace(/@\d+(?:\.\d+){0,2}$/, ""));
  const output = await runNpm(["uninstall", "--no-save", "--package-lock=false", "--no-audit", "--no-fund", ...names]);
  return { changed: true, output: output.slice(-2000), status: dependencyStatus() };
}

function stateFor(sessionId) {
  let state = sessions.get(sessionId);
  if (!state) {
    state = {
      sessionId,
      running: false,
      latestFrame: null,
      analysis: null,
      qrCodes: [],
      motion: { score: 0, active: false },
      updatedAt: null,
      unsubscribe: null,
      timer: null,
    };
    sessions.set(sessionId, state);
  }
  return state;
}

function publicState(state) {
  return {
    sessionId: state.sessionId,
    running: state.running,
    latestFrameAt: state.latestFrame?.timestamp ?? null,
    analysis: state.analysis,
    qrCodes: state.qrCodes,
    motion: state.motion,
    dependencies: dependencyStatus(),
    updatedAt: state.updatedAt,
  };
}

function parseJson(text) {
  const cleaned = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned); } catch { return { description: String(text ?? ""), raw: String(text ?? "") }; }
}

async function getOcrWorker() {
  if (!isInstalled("tesseract.js") || !isInstalled("@tesseract.js-data/deu")) {
    throw new Error("Local OCR pack is not installed");
  }
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      const languageData = require("@tesseract.js-data/deu");
      return createWorker("deu", undefined, { langPath: languageData.langPath });
    })();
  }
  return ocrWorkerPromise;
}

async function runLocalOcr(frame) {
  if (!isInstalled("tesseract.js") || !isInstalled("@tesseract.js-data/deu")) return [];
  const worker = await getOcrWorker();
  const result = await worker.recognize(Buffer.from(frame.data, "base64"));
  const text = String(result?.data?.text ?? "").trim();
  if (!text) return [];
  const confidence = Number(result?.data?.confidence ?? 0) / 100;
  return [{ text, confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : undefined }];
}

async function localScan(context, state) {
  const frame = state.latestFrame ?? await context.agent?.browser?.getFrame(state.sessionId);
  if (!frame) throw new Error("No browser frame available");
  state.latestFrame = frame;
  const text = await runLocalOcr(frame);
  state.analysis = {
    source: "local",
    scene: null,
    people: [],
    objects: [],
    text,
    qrCodes: state.qrCodes,
    motion: state.motion,
    description: text.length
      ? `Lokaler Scan: ${text.length} Textblock erkannt. QR: ${state.qrCodes.length}.`
      : `Lokaler Scan ohne OCR-Treffer. QR: ${state.qrCodes.length}.`,
    available: dependencyStatus(),
  };
  state.updatedAt = new Date().toISOString();
  return publicState(state);
}

async function analyzeFrame(context, state, question) {
  if (context.settings?.VISION_LOCAL_ONLY === true) {
    throw new Error("Vision LLM is disabled because VISION_LOCAL_ONLY is enabled. Use action=local_scan.");
  }
  if (!context.agent) throw new Error("Agent capabilities are unavailable");
  const frame = state.latestFrame ?? await context.agent.browser?.getFrame(state.sessionId);
  if (!frame) throw new Error("No browser frame available");
  state.latestFrame = frame;
  const prompt = question || `Analyze this browser frame. Return ONLY compact JSON with keys: scene {label,confidence}, people [{confidence,bbox}], objects [{type,confidence,bbox}], text [{text,confidence,bbox}], qrCodes [{value,bbox}], description. bbox values should be normalized [x,y,width,height] when possible. Do not invent unreadable text or QR values.`;
  const response = await context.agent.analyzeImage([{ base64: frame.data, mimeType: `image/${frame.format === "png" ? "png" : "jpeg"}` }], prompt);
  state.analysis = parseJson(response);
  if (Array.isArray(state.analysis?.qrCodes)) state.qrCodes = state.analysis.qrCodes;
  state.updatedAt = new Date().toISOString();
  return publicState(state);
}

async function start(context, sessionId) {
  if (!context.agent?.browser) throw new Error("Browser capability unavailable");
  const state = stateFor(sessionId);
  if (state.running) return publicState(state);
  const resolved = await context.agent.browser.startStream(sessionId);
  state.sessionId = resolved;
  state.running = true;
  state.unsubscribe = context.agent.browser.subscribeFrames(resolved, (frame) => { state.latestFrame = frame; });

  const auto = context.settings?.VISION_AUTO_ANALYZE === true && context.settings?.VISION_LOCAL_ONLY !== true;
  const interval = Math.max(2000, Number(context.settings?.VISION_ANALYZE_INTERVAL_MS ?? 5000));
  if (auto) {
    state.timer = setInterval(() => { if (state.latestFrame) void analyzeFrame(context, state).catch(() => {}); }, interval);
  }
  return publicState(state);
}

async function stop(context, sessionId) {
  const state = stateFor(sessionId);
  if (state.unsubscribe) state.unsubscribe();
  if (state.timer) clearInterval(state.timer);
  state.unsubscribe = null;
  state.timer = null;
  state.running = false;
  if (context.agent?.browser) await context.agent.browser.stopStream(sessionId).catch(() => {});
  return publicState(state);
}

export const definition = {
  name: "vision_analyzer",
  description: "Observe DucKI browser sessions with zero-dependency local vision, optional local OCR/ONNX packs, and opt-in LLM vision.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["sessions", "start", "stop", "state", "local_scan", "scan", "query", "report_observation", "dependency_status", "dependency_install", "dependency_remove"] },
      sessionId: { type: "string" },
      question: { type: "string" },
      qrCodes: { type: "array", items: { type: "object" } },
      motion: { type: "object" },
      pack: { type: "string", enum: ["ocr", "onnx"] }
    },
    required: ["action"]
  }
};

export async function execute(input, context) {
  const action = String(input.action ?? "");
  if (action === "dependency_status") return dependencyStatus();
  if (action === "dependency_install") return installPack(String(input.pack ?? ""));
  if (action === "dependency_remove") return removePack(String(input.pack ?? ""));
  if (!context.agent?.browser && action !== "state" && action !== "report_observation") throw new Error("DucKI browser capability unavailable");
  if (action === "sessions") return { sessions: await context.agent.browser.listSessions() };

  const sessionId = String(input.sessionId ?? "").trim();
  if (!sessionId) throw new Error("sessionId is required");
  if (action === "start") return start(context, sessionId);
  if (action === "stop") return stop(context, sessionId);
  if (action === "state") return publicState(stateFor(sessionId));
  if (action === "local_scan") {
    const state = stateFor(sessionId);
    state.latestFrame = await context.agent.browser.getFrame(sessionId);
    return localScan(context, state);
  }
  if (action === "scan") {
    const state = stateFor(sessionId);
    state.latestFrame = await context.agent.browser.getFrame(sessionId);
    return analyzeFrame(context, state);
  }
  if (action === "query") {
    const state = stateFor(sessionId);
    state.latestFrame = await context.agent.browser.getFrame(sessionId);
    return analyzeFrame(context, state, String(input.question ?? "Describe what is happening in this frame."));
  }
  if (action === "report_observation") {
    const state = stateFor(sessionId);
    if (Array.isArray(input.qrCodes)) state.qrCodes = input.qrCodes.slice(0, 32);
    if (input.motion && typeof input.motion === "object") {
      const score = Math.max(0, Math.min(1, Number(input.motion.score ?? 0) || 0));
      state.motion = { score, active: input.motion.active === true };
    }
    state.updatedAt = new Date().toISOString();
    return publicState(state);
  }
  throw new Error(`Unknown action: ${action}`);
}
