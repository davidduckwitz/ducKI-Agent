import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

const execFileAsync = promisify(execFile);
const require = createRequire(fileURLToPath(import.meta.url));
const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const modelsRoot = join(pluginRoot, "models");
const sessions = new Map();
let ocrWorkerPromise = null;
let detectorWorker = null;
let detectorSequence = 0;
const detectorPending = new Map();

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
    description: "ONNX Runtime + Sharp für lokale Personen- und Objekterkennung. Das Erkennungsmodell wird separat installiert.",
    packages: ["onnxruntime-node@1.27.0", "sharp@0.35.3"],
    installArgs: ["--onnxruntime-node-install=skip"],
    probes: ["onnxruntime-node", "sharp"],
  },
};

const MODEL_CATALOG = {
  "yolo26n-coco": {
    id: "yolo26n-coco",
    label: "YOLO26n · COCO 80",
    description: "Kleines 640×640-ONNX-Modell für Personen und 79 weitere COCO-Objektklassen.",
    filename: "yolo26n-coco.onnx",
    downloadUrl: "https://huggingface.co/zwh20081/yolo26-onnx/resolve/main/yolo26n.onnx?download=true",
    sourceUrl: "https://huggingface.co/zwh20081/yolo26-onnx",
    sha256: "356b2726bbdba982e2a304e14b4d9a18b2726b7705b3206093d21331e4dbdd98",
    license: "AGPL-3.0",
    inputSize: 640,
  },
};

const LOCAL_SCENE_RULES = [
  { label: "office", strong: ["laptop", "keyboard", "mouse"], hints: ["chair", "book", "tv", "cell phone"] },
  { label: "kitchen", strong: ["refrigerator", "oven", "microwave"], hints: ["sink", "toaster", "bowl", "fork", "knife", "spoon", "cup"] },
  { label: "bedroom", strong: ["bed"], hints: ["book", "clock", "cell phone", "chair"] },
  { label: "living room", strong: ["couch"], hints: ["tv", "chair", "potted plant", "book", "remote"] },
  { label: "bathroom", strong: ["toilet"], hints: ["sink", "toothbrush", "hair drier"] },
  { label: "dining area", strong: ["dining table"], hints: ["chair", "bowl", "cup", "fork", "knife", "spoon"] },
  { label: "street / traffic", strong: ["traffic light", "stop sign", "bus", "truck"], hints: ["car", "motorcycle", "bicycle", "parking meter"] },
  { label: "outdoor / park", strong: ["bench"], hints: ["bird", "dog", "frisbee", "sports ball", "bicycle"] },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

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
      features: ["browser-stream", "camera-preview", "qr-code", "motion-detection"],
      description: "Funktioniert ohne zusätzliche Node-Pakete und ohne LLM.",
    },
    packs,
  };
}

function modelPath(model) {
  return join(modelsRoot, model.filename);
}

function modelStatus() {
  const models = Object.values(MODEL_CATALOG).map((model) => {
    const path = modelPath(model);
    const installed = existsSync(path);
    let sizeBytes = 0;
    if (installed) {
      try { sizeBytes = statSync(path).size; } catch {}
    }
    return {
      id: model.id,
      label: model.label,
      description: model.description,
      installed,
      sizeBytes,
      license: model.license,
      sourceUrl: model.sourceUrl,
      expectedSha256: model.sha256,
      inputSize: model.inputSize,
    };
  });
  return { models };
}

function packFor(id) {
  const pack = DEPENDENCY_PACKS[id];
  if (!pack) throw new Error(`Unknown dependency pack '${id}'`);
  return pack;
}

function catalogModel(id) {
  const model = MODEL_CATALOG[id];
  if (!model) throw new Error(`Unknown vision model '${id}'`);
  return model;
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

function stopLocalDetectorTimers() {
  for (const state of sessions.values()) {
    if (state.localTimer) clearInterval(state.localTimer);
    state.localTimer = null;
    state.localDetectBusy = false;
  }
}

function rejectDetectorPending(error) {
  for (const [id, entry] of detectorPending) {
    clearTimeout(entry.timer);
    entry.reject(error);
    detectorPending.delete(id);
  }
}

async function stopDetectorWorker() {
  const worker = detectorWorker;
  detectorWorker = null;
  rejectDetectorPending(new Error("Local detector stopped"));
  if (worker) {
    try { await worker.terminate(); } catch {}
  }
}

function ensureDetectorWorker() {
  if (detectorWorker) return detectorWorker;
  if (!DEPENDENCY_PACKS.onnx.probes.every(isInstalled)) {
    throw new Error("Local Vision Runtime is not installed");
  }

  const worker = new Worker(new URL("../runtime/onnx-worker.js", import.meta.url));
  detectorWorker = worker;

  worker.on("message", (message) => {
    const entry = detectorPending.get(message?.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    detectorPending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error || "Local detector failed"));
  });

  worker.on("error", (error) => {
    if (detectorWorker === worker) detectorWorker = null;
    rejectDetectorPending(error instanceof Error ? error : new Error(String(error)));
  });

  worker.on("exit", (code) => {
    if (detectorWorker !== worker) return;
    detectorWorker = null;
    if (code !== 0) rejectDetectorPending(new Error(`Local detector worker exited with code ${code}`));
  });

  return worker;
}

async function runDetector(frame, model, settings) {
  const worker = ensureDetectorWorker();
  const id = `vision_${Date.now()}_${++detectorSequence}`;
  const threshold = clamp(Number(settings?.VISION_OBJECT_CONFIDENCE ?? 0.35), 0.01, 0.99);
  const iouThreshold = clamp(Number(settings?.VISION_OBJECT_IOU ?? 0.45), 0.01, 0.99);
  const maxDetections = Math.max(1, Math.min(300, Number(settings?.VISION_OBJECT_MAX_DETECTIONS ?? 50)));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      detectorPending.delete(id);
      reject(new Error("Local object detection timed out"));
    }, 45_000);
    detectorPending.set(id, { resolve, reject, timer });
    worker.postMessage({
      id,
      type: "detect",
      frameBase64: frame.data,
      modelPath: modelPath(model),
      inputSize: model.inputSize,
      threshold,
      iouThreshold,
      maxDetections,
    });
  });
}

async function installPack(id, context) {
  const pack = packFor(id);
  if (pack.probes.every(isInstalled)) return { changed: false, status: dependencyStatus(), models: modelStatus() };
  const output = await runNpm(["install", "--no-save", "--package-lock=false", "--workspaces=false", "--no-audit", "--no-fund", ...(pack.installArgs ?? []), ...pack.packages]);
  if (id === "onnx") {
    for (const state of sessions.values()) {
      if (state.running) startLocalDetectorTimer(context, state);
    }
  }
  return { changed: true, output: output.slice(-2000), status: dependencyStatus(), models: modelStatus() };
}

async function removePack(id) {
  const pack = packFor(id);
  if (!pack.probes.some(isInstalled)) return { changed: false, status: dependencyStatus(), models: modelStatus() };
  if (id === "ocr" && ocrWorkerPromise) {
    try { (await ocrWorkerPromise)?.terminate?.(); } catch {}
    ocrWorkerPromise = null;
  }
  if (id === "onnx") {
    stopLocalDetectorTimers();
    await stopDetectorWorker();
  }
  const names = pack.packages.map((entry) => entry.replace(/@\d+(?:\.\d+){0,2}$/, ""));
  const output = await runNpm(["uninstall", "--no-save", "--package-lock=false", "--workspaces=false", "--no-audit", "--no-fund", ...names]);
  return { changed: true, output: output.slice(-2000), status: dependencyStatus(), models: modelStatus() };
}

async function installModel(id, context) {
  const model = catalogModel(id);
  const path = modelPath(model);
  if (existsSync(path)) return { changed: false, status: modelStatus() };

  mkdirSync(modelsRoot, { recursive: true });
  const response = await context.fetch(model.downloadUrl);
  if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 100 * 1024 * 1024) throw new Error("Model download exceeds 100 MB safety limit");

  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength > 100 * 1024 * 1024) throw new Error("Model download exceeds 100 MB safety limit");
  const digest = createHash("sha256").update(data).digest("hex");
  if (digest !== model.sha256) {
    throw new Error(`Model checksum mismatch. Expected ${model.sha256}, got ${digest}`);
  }

  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, path);

  for (const state of sessions.values()) {
    if (state.running) startLocalDetectorTimer(context, state);
  }
  return { changed: true, status: modelStatus() };
}

async function removeModel(id) {
  const model = catalogModel(id);
  const path = modelPath(model);
  if (!existsSync(path)) return { changed: false, status: modelStatus() };
  stopLocalDetectorTimers();
  await stopDetectorWorker();
  rmSync(path, { force: true });
  return { changed: true, status: modelStatus() };
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
      detections: { people: [], objects: [], inferenceMs: null, model: null, frameAt: null, scene: null },
      updatedAt: null,
      unsubscribe: null,
      timer: null,
      localTimer: null,
      localDetectBusy: false,
      lastDetectedFrameAt: null,
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
    detections: state.detections,
    dependencies: dependencyStatus(),
    models: modelStatus(),
    updatedAt: state.updatedAt,
  };
}

function parseJson(text) {
  const cleaned = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned); } catch { return { description: String(text ?? ""), raw: String(text ?? "") }; }
}

function resolveOcrLanguagePath() {
  const languageData = require("@tesseract.js-data/deu");
  const exported = languageData?.langPath ?? languageData?.default?.langPath;
  if (typeof exported === "string" && exported.trim()) return exported;
  return dirname(require.resolve("@tesseract.js-data/deu"));
}

function resolveOcrWorkerPath() {
  try {
    return require.resolve("tesseract.js/src/worker-script/node/index.js");
  } catch {
    return undefined;
  }
}

async function getOcrWorker() {
  if (!isInstalled("tesseract.js") || !isInstalled("@tesseract.js-data/deu")) {
    throw new Error("Local OCR pack is not installed");
  }
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const tesseract = await import("tesseract.js");
      const createWorker = tesseract.createWorker;
      const oem = tesseract.OEM?.LSTM_ONLY ?? 1;
      const workerPath = resolveOcrWorkerPath();
      const options = {
        langPath: resolveOcrLanguagePath(),
        cacheMethod: "none",
        gzip: true,
        ...(workerPath ? { workerPath } : {}),
      };
      return createWorker("deu", oem, options);
    })().catch((error) => {
      ocrWorkerPromise = null;
      throw error;
    });
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
  return [{
    text,
    confidence: Number.isFinite(confidence) ? clamp(confidence, 0, 1) : undefined,
  }];
}

function inferLocalScene(people = [], objects = []) {
  const types = new Set(objects.map((entry) => String(entry?.type ?? "").toLowerCase()).filter(Boolean));
  if (people.length > 0) types.add("person");

  let best = null;
  for (const rule of LOCAL_SCENE_RULES) {
    const strongMatches = rule.strong.filter((type) => types.has(type)).length;
    const hintMatches = rule.hints.filter((type) => types.has(type)).length;
    const score = strongMatches * 3 + hintMatches;
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { rule, score, strongMatches, hintMatches };
    }
  }

  if (!best) {
    if (people.length > 0) return { label: "people / unknown environment", confidence: 0.35, source: "object-heuristic" };
    return null;
  }

  const confidence = clamp(0.42 + best.strongMatches * 0.18 + best.hintMatches * 0.07, 0.42, 0.92);
  return {
    label: best.rule.label,
    confidence: Math.round(confidence * 100) / 100,
    source: "object-heuristic",
    evidence: [...best.rule.strong, ...best.rule.hints].filter((type) => types.has(type)).slice(0, 8),
  };
}

function selectedModel(context) {
  const requested = String(context.settings?.VISION_OBJECT_MODEL ?? "yolo26n-coco");
  const model = MODEL_CATALOG[requested] ?? MODEL_CATALOG["yolo26n-coco"];
  return existsSync(modelPath(model)) ? model : null;
}

async function runLocalObjects(context, frame) {
  const runtimeReady = DEPENDENCY_PACKS.onnx.probes.every(isInstalled);
  const model = selectedModel(context);
  if (!runtimeReady || !model) {
    return {
      people: [],
      objects: [],
      inferenceMs: null,
      model: model?.id ?? null,
      scene: null,
      skipped: !runtimeReady ? "Local Vision Runtime not installed" : "Object detection model not installed",
    };
  }
  const result = await runDetector(frame, model, context.settings);
  return { ...result, model: model.id, scene: inferLocalScene(result.people, result.objects) };
}

function applyDetectionState(state, frame, detection) {
  state.detections = {
    people: detection.people ?? [],
    objects: detection.objects ?? [],
    scene: detection.scene ?? inferLocalScene(detection.people ?? [], detection.objects ?? []),
    inferenceMs: detection.inferenceMs ?? null,
    model: detection.model ?? null,
    outputShape: detection.outputShape,
    tracking: detection.tracking,
    frameAt: frame.timestamp,
    skipped: detection.skipped,
  };
  state.lastDetectedFrameAt = frame.timestamp;
}

async function updateBackgroundDetections(context, state) {
  if (state.localDetectBusy || !state.latestFrame) return;
  if (state.lastDetectedFrameAt === state.latestFrame.timestamp) return;
  state.localDetectBusy = true;
  const frame = state.latestFrame;
  try {
    const detection = await runLocalObjects(context, frame);
    applyDetectionState(state, frame, detection);
    state.updatedAt = new Date().toISOString();
    if (state.analysis?.source === "local") {
      state.analysis.scene = state.detections.scene;
      state.analysis.people = state.detections.people;
      state.analysis.objects = state.detections.objects;
      state.analysis.objectDetection = state.detections;
    }
  } catch (error) {
    state.detections = {
      ...state.detections,
      error: error instanceof Error ? error.message : String(error),
      frameAt: frame.timestamp,
    };
  } finally {
    state.localDetectBusy = false;
  }
}

function startLocalDetectorTimer(context, state) {
  if (state.localTimer) return;
  if (context.settings?.VISION_LOCAL_AUTO_DETECT === false) return;
  if (!DEPENDENCY_PACKS.onnx.probes.every(isInstalled) || !selectedModel(context)) return;
  const fps = clamp(Number(context.settings?.VISION_LOCAL_OBJECT_FPS ?? 2), 0.2, 15);
  const interval = Math.max(67, Math.round(1000 / fps));
  state.localTimer = setInterval(() => {
    void updateBackgroundDetections(context, state);
  }, interval);
  void updateBackgroundDetections(context, state);
}

async function localScan(context, state) {
  const frame = state.latestFrame ?? await context.agent?.browser?.getFrame(state.sessionId);
  if (!frame) throw new Error("No visual frame available");
  state.latestFrame = frame;

  const warnings = [];
  const [textResult, detectionResult] = await Promise.allSettled([
    runLocalOcr(frame),
    runLocalObjects(context, frame),
  ]);
  const text = textResult.status === "fulfilled" ? textResult.value : [];
  if (textResult.status === "rejected") warnings.push(`OCR: ${textResult.reason?.message ?? String(textResult.reason)}`);

  const detection = detectionResult.status === "fulfilled"
    ? detectionResult.value
    : { people: [], objects: [], scene: null, inferenceMs: null, model: null };
  if (detectionResult.status === "rejected") warnings.push(`Objects: ${detectionResult.reason?.message ?? String(detectionResult.reason)}`);

  applyDetectionState(state, frame, detection);

  const peopleCount = state.detections.people.length;
  const objectCount = state.detections.objects.length;
  const sceneLabel = state.detections.scene?.label ?? "unbekannt";
  state.analysis = {
    source: "local",
    scene: state.detections.scene,
    people: state.detections.people,
    objects: state.detections.objects,
    text,
    qrCodes: state.qrCodes,
    motion: state.motion,
    objectDetection: state.detections,
    description: `Lokaler Scan: Szene ${sceneLabel}; ${peopleCount} Person(en), ${objectCount} Objekt(e), ${text.length} OCR-Block/Blöcke, ${state.qrCodes.length} QR-Code(s).`,
    warnings,
    available: {
      dependencies: dependencyStatus(),
      models: modelStatus(),
    },
  };
  state.updatedAt = new Date().toISOString();
  return publicState(state);
}

function providedFrame(input, sessionId) {
  const raw = String(input.frameBase64 ?? "").trim();
  if (!raw) throw new Error("frameBase64 is required");
  const data = raw.replace(/^data:image\/(?:png|jpe?g|webp);base64,/i, "");
  if (data.length > 20 * 1024 * 1024) throw new Error("Provided frame exceeds the 20 MB base64 safety limit");
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data)) throw new Error("frameBase64 is not valid base64 image data");
  const requestedFormat = String(input.frameFormat ?? "jpeg").toLowerCase();
  const format = requestedFormat === "png" ? "png" : "jpeg";
  return {
    sessionId,
    data,
    format,
    timestamp: new Date().toISOString(),
  };
}

async function localProvidedFrameDetect(context, state, frame) {
  state.latestFrame = frame;
  const detection = await runLocalObjects(context, frame);
  applyDetectionState(state, frame, detection);
  state.analysis = {
    ...(state.analysis?.source === "local" ? state.analysis : {}),
    source: "local",
    scene: state.detections.scene,
    people: state.detections.people,
    objects: state.detections.objects,
    text: Array.isArray(state.analysis?.text) ? state.analysis.text : [],
    qrCodes: state.qrCodes,
    motion: state.motion,
    objectDetection: state.detections,
    description: `Lokale Live-Erkennung: ${state.detections.people.length} Person(en), ${state.detections.objects.length} Objekt(e).`,
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
  if (!frame) throw new Error("No visual frame available");
  state.latestFrame = frame;
  const prompt = question || `Analyze this visual frame. Return ONLY compact JSON with keys: scene {label,confidence}, people [{confidence,bbox}], objects [{type,confidence,bbox}], text [{text,confidence,bbox}], qrCodes [{value,bbox}], description. bbox values should be normalized [x,y,width,height] when possible. Do not invent unreadable text or QR values.`;
  const response = await context.agent.analyzeImage(
    [{ base64: frame.data, mimeType: `image/${frame.format === "png" ? "png" : "jpeg"}` }],
    prompt,
  );
  state.analysis = parseJson(response);
  if (Array.isArray(state.analysis?.qrCodes)) state.qrCodes = state.analysis.qrCodes;
  state.updatedAt = new Date().toISOString();
  return publicState(state);
}

async function start(context, sessionId) {
  if (!context.agent?.browser) throw new Error("Browser capability unavailable");
  const state = stateFor(sessionId);
  if (state.running) {
    startLocalDetectorTimer(context, state);
    return publicState(state);
  }
  const resolved = await context.agent.browser.startStream(sessionId);
  if (resolved !== sessionId) {
    sessions.delete(sessionId);
    state.sessionId = resolved;
    sessions.set(resolved, state);
  }
  state.running = true;
  state.unsubscribe = context.agent.browser.subscribeFrames(resolved, (frame) => {
    state.latestFrame = frame;
  });

  const auto = context.settings?.VISION_AUTO_ANALYZE === true && context.settings?.VISION_LOCAL_ONLY !== true;
  const interval = Math.max(2000, Number(context.settings?.VISION_ANALYZE_INTERVAL_MS ?? 5000));
  if (auto) {
    state.timer = setInterval(() => {
      if (state.latestFrame) void analyzeFrame(context, state).catch(() => {});
    }, interval);
  }

  startLocalDetectorTimer(context, state);
  return publicState(state);
}

async function stop(context, sessionId) {
  const state = stateFor(sessionId);
  if (state.unsubscribe) state.unsubscribe();
  if (state.timer) clearInterval(state.timer);
  if (state.localTimer) clearInterval(state.localTimer);
  state.unsubscribe = null;
  state.timer = null;
  state.localTimer = null;
  state.localDetectBusy = false;
  state.running = false;
  if (context.agent?.browser) await context.agent.browser.stopStream(sessionId).catch(() => {});
  return publicState(state);
}

function closeLocalSource(sessionId) {
  const state = sessions.get(sessionId);
  if (state?.timer) clearInterval(state.timer);
  if (state?.localTimer) clearInterval(state.localTimer);
  if (state?.unsubscribe) state.unsubscribe();
  sessions.delete(sessionId);
  return { closed: true, sessionId };
}

export const definition = {
  name: "vision_analyzer",
  description: "Observe DucKI browser or camera frames with zero-dependency local vision, optional offline OCR/ONNX object detection, local scene inference/tracking, and opt-in LLM vision.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "sessions", "start", "stop", "state", "local_scan", "scan", "query", "report_observation",
          "local_frame_detect", "local_frame_scan", "local_source_stop",
          "dependency_status", "dependency_install", "dependency_remove",
          "model_status", "model_install", "model_remove",
        ],
      },
      sessionId: { type: "string" },
      question: { type: "string" },
      qrCodes: { type: "array", items: { type: "object" } },
      motion: { type: "object" },
      pack: { type: "string", enum: ["ocr", "onnx"] },
      model: { type: "string", enum: ["yolo26n-coco"] },
      frameBase64: { type: "string", description: "Base64 image data for a local source such as camera. Do not use for browser sessions." },
      frameFormat: { type: "string", enum: ["jpeg", "png"] },
    },
    required: ["action"],
  },
};

export async function execute(input, context) {
  const action = String(input.action ?? "");

  if (action === "dependency_status") return dependencyStatus();
  if (action === "dependency_install") return installPack(String(input.pack ?? ""), context);
  if (action === "dependency_remove") return removePack(String(input.pack ?? ""));
  if (action === "model_status") return modelStatus();
  if (action === "model_install") return installModel(String(input.model ?? ""), context);
  if (action === "model_remove") return removeModel(String(input.model ?? ""));

  if (action === "local_frame_detect" || action === "local_frame_scan") {
    const sessionId = String(input.sessionId ?? "camera:local").trim() || "camera:local";
    const state = stateFor(sessionId);
    const frame = providedFrame(input, sessionId);
    if (action === "local_frame_detect") return localProvidedFrameDetect(context, state, frame);
    state.latestFrame = frame;
    return localScan(context, state);
  }

  if (action === "local_source_stop") {
    const sessionId = String(input.sessionId ?? "camera:local").trim() || "camera:local";
    return closeLocalSource(sessionId);
  }

  if (!context.agent?.browser && action !== "state" && action !== "report_observation") {
    throw new Error("DucKI browser capability unavailable. The plugin requires permission 'browser.frames'.");
  }
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
      const score = clamp(Number(input.motion.score ?? 0) || 0, 0, 1);
      state.motion = { score, active: input.motion.active === true };
    }
    state.updatedAt = new Date().toISOString();
    return publicState(state);
  }

  throw new Error(`Unknown action: ${action}`);
}
