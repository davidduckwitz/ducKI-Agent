import * as ort from "onnxruntime-web/wasm";
// Relative path on purpose: the package's export map hides dist/, but Vite still needs to emit
// the wasm as an asset so it is served same-origin (desktop CSP) and works offline.
import ortWasmUrl from "../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url";
// The glue module too: Vite's dev pre-bundling moves ort into .vite/deps, where its relative
// lookup of the .mjs fails.
import ortMjsUrl from "../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url";
import type { WakeWordEngine } from "./types";

/**
 * openWakeWord in the browser - the same three-stage pipeline as the Python package
 * (openwakeword/utils.py AudioFeatures + Model):
 *   1. melspectrogram.onnx: int16-valued float PCM -> 32-bin mel frames (8 per 80 ms chunk,
 *      which needs 480 samples of left context), scaled with x/10 + 2
 *   2. embedding_model.onnx: sliding window of 76 mel frames -> one 96-d embedding per chunk
 *   3. classifier: the last N embeddings [1, N, 96] -> score 0..1
 */
const CHUNK = 1280;
const CONTEXT = 480;
const MEL_WINDOW = 76;
const WARMUP_PREDICTIONS = 5;
const COOLDOWN_MS = 2000;

let configured = false;
function configureRuntime() {
  if (configured) return;
  configured = true;
  ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
  // Threads need cross-origin isolation (SharedArrayBuffer), which the app does not have.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
}

async function loadSession(url: string): Promise<ort.InferenceSession> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error || `Wake-Word-Modell konnte nicht geladen werden (${response.status})`);
  }
  return ort.InferenceSession.create(new Uint8Array(await response.arrayBuffer()), { executionProviders: ["wasm"] });
}

function embeddingCount(session: ort.InferenceSession): number {
  const meta = session.inputMetadata?.[0];
  const dim = meta && meta.isTensor ? meta.shape[1] : undefined;
  return typeof dim === "number" && dim > 0 ? dim : 16;
}

export interface OpenWakeWordOptions {
  modelUrl: string;
  featureUrl: (file: string) => string;
  threshold: number;
  onDetect: () => void;
  onScore?: (score: number) => void;
}

export async function createOpenWakeWordEngine(options: OpenWakeWordOptions): Promise<WakeWordEngine> {
  configureRuntime();
  const [mel, embedding, classifier] = await Promise.all([
    loadSession(options.featureUrl("melspectrogram.onnx")),
    loadSession(options.featureUrl("embedding_model.onnx")),
    loadSession(options.modelUrl),
  ]);
  const featureCount = embeddingCount(classifier);

  let context = new Float32Array(CONTEXT);
  // Python seeds the mel buffer with ones so the very first embedding has a full window.
  const melFrames: Float32Array[] = Array.from({ length: MEL_WINDOW }, () => new Float32Array(32).fill(1));
  const embeddings: Float32Array[] = [];
  let predictions = 0;
  let lastDetection = 0;
  let queue: Int16Array[] = [];
  let running = false;
  let released = false;

  const step = async (pcm: Int16Array) => {
    const input = new Float32Array(CONTEXT + CHUNK);
    input.set(context, 0);
    for (let i = 0; i < CHUNK; i++) input[CONTEXT + i] = pcm[i] ?? 0;
    context = input.slice(CHUNK);

    const melOut = await mel.run({ [mel.inputNames[0]!]: new ort.Tensor("float32", input, [1, input.length]) });
    const melData = melOut[mel.outputNames[0]!]!.data as Float32Array;
    for (let offset = 0; offset + 32 <= melData.length; offset += 32) {
      const frame = new Float32Array(32);
      for (let j = 0; j < 32; j++) frame[j] = melData[offset + j]! / 10 + 2;
      melFrames.push(frame);
    }
    melFrames.splice(0, Math.max(0, melFrames.length - MEL_WINDOW));

    const window = new Float32Array(MEL_WINDOW * 32);
    melFrames.forEach((frame, index) => window.set(frame, index * 32));
    const embOut = await embedding.run({ [embedding.inputNames[0]!]: new ort.Tensor("float32", window, [1, MEL_WINDOW, 32, 1]) });
    embeddings.push(new Float32Array(embOut[embedding.outputNames[0]!]!.data as Float32Array));
    embeddings.splice(0, Math.max(0, embeddings.length - featureCount));
    if (embeddings.length < featureCount) return;

    const features = new Float32Array(featureCount * 96);
    embeddings.forEach((vector, index) => features.set(vector, index * 96));
    const out = await classifier.run({ [classifier.inputNames[0]!]: new ort.Tensor("float32", features, [1, featureCount, 96]) });
    const score = (out[classifier.outputNames[0]!]!.data as Float32Array)[0] ?? 0;
    options.onScore?.(score);
    if (++predictions <= WARMUP_PREDICTIONS) return;
    const now = Date.now();
    if (score >= options.threshold && now - lastDetection > COOLDOWN_MS) {
      lastDetection = now;
      options.onDetect();
    }
  };

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.length && !released) await step(queue.shift()!);
    } catch (error) {
      console.warn("[wakeword] openWakeWord inference failed", error);
    } finally {
      running = false;
    }
  };

  return {
    frameLength: CHUNK,
    process: (pcm) => {
      if (released) return;
      queue.push(pcm);
      // A slow device must not build an ever-growing backlog (stale audio = late detection).
      if (queue.length > 12) queue = queue.slice(-4);
      void drain();
    },
    reset: () => {
      queue = [];
      embeddings.length = 0;
      predictions = 0;
    },
    release: async () => {
      released = true;
      queue = [];
      await Promise.all([mel.release(), embedding.release(), classifier.release()]).catch(() => {});
    },
  };
}
