/**
 * Gemeinsame Transkriptions-Pipeline (nodejs-whisper) -- ein Ort statt Kopien fuer:
 *  - den lokalen /api/chat/transcribe-Endpoint (Mikrofon-Button in der React-WebUI)
 *  - den Cloud-Control-Befehl `voice.transcribe` (Voice-App auf ducki.cloud, siehe
 *    cloud-control.ts) -- dieselbe Pipeline, die auch der Discord-Gateway-Sprachkanal nutzt.
 */
import type { DatabaseService } from "@ducki/database";
import { createSpeechToTextProvider, resolveNodejsWhisperCudaDefault, resolveNodejsWhisperModelDefault } from "@ducki/providers";
import { transcribeViaSttServer } from "./stt-runtime.js";

function stripTimestamps(text: string): string {
  // Whisper-Zeitstempel wie "[00:00:00.000 --> 00:00:02.000]" entfernen.
  return text.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/gm, "").trim();
}

function readSetting(settings: Map<string, string>, key: string, defaultValue?: string): string | undefined {
  return settings.get(key) || defaultValue;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

/** Browser-Aufnahmen sind meist webm/opus - mit korrekter Endung erkennt ffmpeg das Format sofort. */
function extensionForMime(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  return undefined;
}

export async function transcribeAudioBuffer(
  db: DatabaseService,
  audioBuffer: Buffer,
  opts: { language?: string; mimeType?: string; partial?: boolean } = {}
): Promise<string> {
  const allSettings = await db.getAllSettings();
  const settingsMap = new Map(allSettings.map((s) => [s.key, s.value]));
  const language = opts.language?.trim() || readSetting(settingsMap, "NODEJS_WHISPER_LANGUAGE") || "de";

  // faster-whisper-Server: Modell bleibt geladen, CUDA/VAD. Fallback auf nodejs-whisper, wenn er
  // nicht laeuft - Live-Teilergebnisse (partial) gibt es nur ueber den Server.
  if (readSetting(settingsMap, "DEFAULT_SPEECH_TO_TEXT_PROVIDER") === "faster-whisper") {
    try {
      return stripTimestamps(await transcribeViaSttServer(db, audioBuffer, { language, partial: opts.partial }));
    } catch (error) {
      if (opts.partial) throw error;
      console.warn(`[STT] faster-whisper nicht verfuegbar, Fallback nodejs-whisper: ${error instanceof Error ? error.message : error}`);
    }
  } else if (opts.partial) {
    throw new Error("Live-Transkription erfordert den faster-whisper STT-Server");
  }

  const provider = createSpeechToTextProvider({
    name: "nodejs-whisper",
    model: readSetting(settingsMap, "NODEJS_WHISPER_MODEL_NAME") ?? resolveNodejsWhisperModelDefault(),
    modelRootPath: readSetting(settingsMap, "NODEJS_WHISPER_MODEL_ROOT_PATH"),
    autoDownloadModel: parseBoolean(readSetting(settingsMap, "NODEJS_WHISPER_AUTO_DOWNLOAD", "true"), true),
    withCuda: parseBoolean(readSetting(settingsMap, "NODEJS_WHISPER_USE_CUDA"), resolveNodejsWhisperCudaDefault()),
    timeoutMs: Number.parseInt(readSetting(settingsMap, "NODEJS_WHISPER_TIMEOUT_MS", "60000") ?? "60000", 10),
    inputExt: extensionForMime(opts.mimeType),
  });

  const result = await provider.transcribe(audioBuffer, { language });

  let text = "";
  if (typeof result === "string") {
    text = result.trim();
  } else if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    text = String(obj["text"] ?? obj["transcript"] ?? result).trim();
  } else {
    text = String(result).trim();
  }

  return stripTimestamps(text);
}
