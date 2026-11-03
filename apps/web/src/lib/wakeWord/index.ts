import { getVoiceAudioContext } from "../voiceActivityDetection";
import type { VoiceSettings } from "../../hooks/useVoiceSettings";
import type { WakeWordEngine } from "./types";

// Served from public/ as a real file: Vite would inline a small ?url import as a data: URL,
// which the desktop CSP (script-src 'self') blocks for audioWorklet.addModule.
const workletUrl = `${import.meta.env.BASE_URL}wake-word-pcm.js`;

export type WakeWordProvider = "openwakeword" | "porcupine";

export interface WakeWordListenerHandle {
  stop: () => void;
}

export function wakeWordFileUrl(engine: WakeWordProvider, source: string, id: string): string {
  return `/api/wakeword/file/${engine}/${source}/${id.split("/").map(encodeURIComponent).join("/")}`;
}

/** "builtin:hey_jarvis" -> ["builtin", "hey_jarvis"]; ids may contain ':' themselves. */
export function splitModelRef(ref: string, fallbackSource: string): [string, string] {
  const index = ref.indexOf(":");
  return index < 0 ? [fallbackSource, ref] : [ref.slice(0, index), ref.slice(index + 1)];
}

// Engines are cached across arm/disarm cycles: loading the ONNX/WASM models costs ~1 s and
// every agent reply re-arms the listener. The cache key changes whenever a setting that
// affects the model changes.
let cached: { key: string; engine: Promise<WakeWordEngine> } | null = null;
let detectHandler: (() => void) | null = null;

function engineKey(settings: VoiceSettings): string {
  return settings.wakeWordProvider === "porcupine"
    ? ["porcupine", settings.wakeWordPorcupineKeyword, settings.wakeWordPorcupineLanguage, settings.wakeWordPorcupineSensitivity, settings.wakeWordPorcupineAccessKey].join("|")
    : ["openwakeword", settings.wakeWordOwwModel, settings.wakeWordOwwThreshold].join("|");
}

async function createEngine(settings: VoiceSettings): Promise<WakeWordEngine> {
  const onDetect = () => detectHandler?.();
  if (settings.wakeWordProvider === "porcupine") {
    const { createPorcupineEngine } = await import("./porcupine");
    return createPorcupineEngine({
      accessKey: settings.wakeWordPorcupineAccessKey,
      keyword: settings.wakeWordPorcupineKeyword,
      keywordUrl: (file) => wakeWordFileUrl("porcupine", "custom", file),
      paramsUrl: wakeWordFileUrl("porcupine", "params", settings.wakeWordPorcupineLanguage),
      language: settings.wakeWordPorcupineLanguage,
      sensitivity: settings.wakeWordPorcupineSensitivity,
      onDetect,
    });
  }
  const { createOpenWakeWordEngine } = await import("./openWakeWord");
  const [source, id] = splitModelRef(settings.wakeWordOwwModel, "builtin");
  return createOpenWakeWordEngine({
    modelUrl: wakeWordFileUrl("openwakeword", source, id),
    featureUrl: (file) => wakeWordFileUrl("openwakeword", "feature", file),
    threshold: settings.wakeWordOwwThreshold,
    onDetect,
  });
}

function getEngine(settings: VoiceSettings): Promise<WakeWordEngine> {
  const key = engineKey(settings);
  if (cached?.key === key) return cached.engine;
  const previous = cached;
  const engine = createEngine(settings);
  cached = { key, engine };
  // A failed load must not stick: the next arm retries (e.g. after fixing the AccessKey).
  engine.catch(() => { if (cached?.engine === engine) cached = null; });
  void previous?.engine.then((old) => old.release()).catch(() => {});
  return engine;
}

/** Loads the configured engine ahead of time (e.g. when the toggle is switched on). */
export function preloadWakeWordEngine(settings: VoiceSettings): Promise<void> {
  return getEngine(settings).then(() => undefined);
}

export function releaseWakeWordEngine(): void {
  const current = cached;
  cached = null;
  void current?.engine.then((engine) => engine.release()).catch(() => {});
}

/**
 * Feeds the mic stream into the configured detector until `stop()` or a detection. Resolves
 * once the engine is ready, so callers can surface load errors (missing AccessKey, model
 * download failed) instead of silently never triggering.
 */
export async function startWakeWordListener(stream: MediaStream, settings: VoiceSettings, onDetect: () => void): Promise<WakeWordListenerHandle> {
  const context = getVoiceAudioContext();
  if (!context) throw new Error("Web Audio wird von diesem Browser nicht unterstützt.");
  const engine = await getEngine(settings);
  await context.audioWorklet.addModule(workletUrl);
  void context.resume().catch(() => {});
  engine.reset();

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "wake-word-pcm", { processorOptions: { frameLength: engine.frameLength } });
  // Worklets are only pulled while connected to the destination; a muted gain keeps it silent.
  const sink = context.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(context.destination);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (detectHandler === handleDetect) detectHandler = null;
    node.port.onmessage = null;
    try { source.disconnect(); node.disconnect(); sink.disconnect(); } catch { /* already gone */ }
  };
  const handleDetect = () => {
    if (stopped) return;
    stop();
    engine.reset();
    onDetect();
  };
  detectHandler = handleDetect;
  node.port.onmessage = (event: MessageEvent<Int16Array>) => { if (!stopped) engine.process(event.data); };
  return { stop };
}

/** Short two-tone "I'm listening" cue. */
export function playWakeChime(): void {
  const context = getVoiceAudioContext();
  if (!context) return;
  const now = context.currentTime;
  [880, 1320].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    const start = now + index * 0.09;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.16);
  });
}

/**
 * Whisper usually also transcribes the tail of the wake phrase ("… Jarvis, wie spät ist es?").
 * Drops leading words that loosely match the configured phrase.
 */
export function stripWakePhrase(text: string, phrase: string): string {
  const normalize = (value: string) => value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
  const phraseWords = phrase.split(/\s+/).map(normalize).filter(Boolean);
  if (!phraseWords.length) return text;
  const words = text.trim().split(/\s+/);
  let drop = 0;
  for (let i = 0; i < Math.min(words.length, phraseWords.length + 1); i++) {
    const word = normalize(words[i] ?? "");
    if (word && phraseWords.some((target) => similarity(word, target) >= 0.6)) drop = i + 1;
    else if (drop > 0 || i > 0) break;
  }
  // Empty when only the wake phrase was spoken - the caller then keeps listening.
  return words.slice(drop).join(" ").replace(/^[\s,.!?;:–-]+/, "");
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return 1 - rows[a.length]![b.length]! / Math.max(a.length, b.length);
}
