import { BuiltInKeyword, PorcupineWorker, type PorcupineKeyword } from "@picovoice/porcupine-web";
import type { WakeWordEngine } from "./types";

export const PORCUPINE_BUILTIN_KEYWORDS = Object.values(BuiltInKeyword) as string[];

async function fetchBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error || `Porcupine-Datei konnte nicht geladen werden (${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export interface PorcupineOptions {
  accessKey: string;
  /** "builtin:Jarvis" or "custom:<file>.ppn" */
  keyword: string;
  keywordUrl: (file: string) => string;
  paramsUrl: string;
  language: string;
  sensitivity: number;
  onDetect: () => void;
}

/**
 * Picovoice Porcupine (WASM, in a worker). Needs an AccessKey from console.picovoice.ai; the
 * key is validated online by the SDK. We fetch the model files through our own /api so the
 * deployed web UI (other origin than the backend) works, and hand them over as base64.
 */
export async function createPorcupineEngine(options: PorcupineOptions): Promise<WakeWordEngine> {
  if (!options.accessKey.trim()) throw new Error("Porcupine braucht einen AccessKey (console.picovoice.ai) – bitte in den Einstellungen eintragen.");
  const [kind, ...rest] = options.keyword.split(":");
  const name = rest.join(":");
  let keyword: PorcupineKeyword;
  if (kind === "custom") {
    keyword = {
      base64: await fetchBase64(options.keywordUrl(name)),
      label: name.replace(/\.ppn$/i, ""),
      customWritePath: `ducki_ppn_${name}`,
      forceWrite: true,
      sensitivity: options.sensitivity,
    };
  } else {
    if (options.language !== "en") throw new Error("Eingebaute Porcupine-Wörter gibt es nur auf Englisch – Sprache auf Englisch stellen oder eine eigene .ppn-Datei nutzen.");
    const builtin = (PORCUPINE_BUILTIN_KEYWORDS.includes(name) ? name : BuiltInKeyword.Jarvis) as BuiltInKeyword;
    keyword = { builtin, sensitivity: options.sensitivity };
  }
  const worker = await PorcupineWorker.create(
    options.accessKey.trim(),
    keyword,
    () => options.onDetect(),
    { base64: await fetchBase64(options.paramsUrl), customWritePath: `ducki_porcupine_${options.language}`, forceWrite: true },
    { processErrorCallback: (error) => console.warn("[wakeword] Porcupine error", error) },
  );
  return {
    frameLength: worker.frameLength,
    process: (pcm) => worker.process(pcm),
    reset: () => {},
    release: async () => {
      await worker.release().catch(() => {});
      worker.terminate();
    },
  };
}
