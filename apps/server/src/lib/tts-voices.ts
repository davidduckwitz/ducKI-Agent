import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Shared reference-voice library for every local TTS engine (Chatterbox, Qwen3-TTS): one folder
 * of `<id>.wav` clips, optionally with `<id>.txt` holding the spoken text (improves cloning).
 * The Python servers read the same folder (apps/server/scripts/voices/).
 */
export const VOICES_DIR = fileURLToPath(new URL("../../scripts/voices/", import.meta.url));

/** Used when no voice is configured and the clip exists. */
export const DEFAULT_REFERENCE_VOICE = "cryptnana-1";

export const MAX_VOICE_BYTES = 30 * 1024 * 1024;
const VOICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function assertVoiceId(id: string): string {
  if (!VOICE_ID.test(id)) throw new Error("Ungültiger Name: nur Buchstaben, Ziffern, _ und - (max. 64 Zeichen).");
  return id;
}

export function defaultReferenceVoice(): string | undefined {
  return existsSync(`${VOICES_DIR}${DEFAULT_REFERENCE_VOICE}.wav`) ? DEFAULT_REFERENCE_VOICE : undefined;
}

export interface VoiceEntry { id: string; sizeBytes: number; hasTranscript: boolean; transcript?: string }

export async function listVoices(): Promise<VoiceEntry[]> {
  if (!existsSync(VOICES_DIR)) return [];
  const entries: VoiceEntry[] = [];
  for (const file of (await readdir(VOICES_DIR)).sort()) {
    if (!file.toLowerCase().endsWith(".wav")) continue;
    const id = file.slice(0, -4);
    if (!VOICE_ID.test(id)) continue;
    const transcriptPath = `${VOICES_DIR}${id}.txt`;
    const transcript = existsSync(transcriptPath) ? (await readFile(transcriptPath, "utf8")).trim() : "";
    entries.push({ id, sizeBytes: (await stat(`${VOICES_DIR}${file}`)).size, hasTranscript: !!transcript,
      ...(transcript ? { transcript } : {}) });
  }
  return entries;
}

function assertWav(buffer: Buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Keine gültige WAV-Datei (RIFF/WAVE-Header fehlt).");
  }
}

export async function saveVoice(id: string, audio: Buffer, overwrite: boolean) {
  assertVoiceId(id);
  assertWav(audio);
  if (audio.length > MAX_VOICE_BYTES) throw new Error("Datei zu groß (max. 30 MB).");
  await mkdir(VOICES_DIR, { recursive: true });
  if (!overwrite && existsSync(`${VOICES_DIR}${id}.wav`)) throw new Error(`Stimme „${id}“ existiert bereits.`);
  await writeFile(`${VOICES_DIR}${id}.wav`, audio);
}

export async function saveTranscript(id: string, text: string) {
  assertVoiceId(id);
  if (!existsSync(`${VOICES_DIR}${id}.wav`)) throw new Error(`Stimme „${id}“ nicht gefunden.`);
  const trimmed = text.trim();
  if (trimmed) await writeFile(`${VOICES_DIR}${id}.txt`, trimmed, "utf8");
  else await rm(`${VOICES_DIR}${id}.txt`, { force: true });
}

export async function deleteVoice(id: string) {
  assertVoiceId(id);
  await rm(`${VOICES_DIR}${id}.wav`, { force: true });
  await rm(`${VOICES_DIR}${id}.txt`, { force: true });
}
