/**
 * Gemeinsame Transkriptions-Pipeline (nodejs-whisper) -- ein Ort statt Kopien fuer:
 *  - den lokalen /api/chat/transcribe-Endpoint (Mikrofon-Button in der React-WebUI)
 *  - den Cloud-Control-Befehl `voice.transcribe` (Voice-App auf ducki.cloud, siehe
 *    cloud-control.ts) -- dieselbe Pipeline, die auch der Discord-Gateway-Sprachkanal nutzt.
 */
import type { DatabaseService } from "@ducki/database";
import { createSpeechToTextProvider } from "@ducki/providers";

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

export async function transcribeAudioBuffer(
  db: DatabaseService,
  audioBuffer: Buffer,
  opts: { language?: string } = {}
): Promise<string> {
  const allSettings = await db.getAllSettings();
  const settingsMap = new Map(allSettings.map((s) => [s.key, s.value]));

  const provider = createSpeechToTextProvider({
    name: "nodejs-whisper",
    model: readSetting(settingsMap, "NODEJS_WHISPER_MODEL_NAME", "base"),
    modelRootPath: readSetting(settingsMap, "NODEJS_WHISPER_MODEL_ROOT_PATH"),
    autoDownloadModel: parseBoolean(readSetting(settingsMap, "NODEJS_WHISPER_AUTO_DOWNLOAD", "true"), true),
    withCuda: parseBoolean(readSetting(settingsMap, "NODEJS_WHISPER_USE_CUDA", "false"), false),
    timeoutMs: Number.parseInt(readSetting(settingsMap, "NODEJS_WHISPER_TIMEOUT_MS", "180000") ?? "180000", 10),
  });

  const result = await provider.transcribe(audioBuffer, { language: opts.language ?? "de" });

  let text = "";
  if (typeof result === "string") {
    text = result.trim();
  } else if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    text = String(obj["text"] ?? obj["transcript"] ?? result).trim();
  } else {
    text = String(result).trim();
  }

  // Whisper-Zeitstempel wie "[00:00:00.000 --> 00:00:02.000]" entfernen.
  text = text.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/gm, "").trim();

  return text;
}
