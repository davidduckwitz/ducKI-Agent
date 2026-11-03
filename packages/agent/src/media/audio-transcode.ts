/**
 * Joins and converts synthesized speech clips into one exportable file (WAV or MP3) for
 * plugins (AgentCapabilities.speech.transcode). TTS providers return whatever their engine
 * produces (Chatterbox/Piper/Qwen -> WAV, OpenAI/ElevenLabs -> MP3), and long texts are
 * synthesized chunk by chunk, so an export needs a concat + transcode step.
 *
 * ffmpeg (media/binaries.ts) does the real work. Without it, two cases still work in pure JS:
 * a single clip that already has the target format, and PCM WAV clips with identical format
 * joined into a WAV. Everything else (any MP3 output from WAV input, mixed formats, resampling)
 * fails with a message pointing at the installable ffmpeg component.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findFfmpeg } from "./binaries.js";

export type AudioExportFormat = "wav" | "mp3";

export interface AudioClip {
  audio: Buffer;
  mimeType: string;
}

export interface TranscodeAudioOptions {
  format: AudioExportFormat;
  /** MP3 bitrate in kbit/s (ignored for WAV). Default 192. */
  bitrateKbps?: number;
  /** Output sample rate; omitted keeps the first clip's rate (ffmpeg) or the clips' rate (JS). */
  sampleRate?: number;
  /** 1 = mono, 2 = stereo; omitted keeps the source layout. */
  channels?: 1 | 2;
  /** Silence inserted between clips, in milliseconds. Default 0. */
  gapMs?: number;
  /** Playback speed factor 0.5-2 without pitch change (Voice tab "Geschwindigkeit"). Default 1. */
  tempo?: number;
  /** Pitch factor 0.5-2 at constant speed (Voice tab "Tonhöhe"). Default 1. */
  pitch?: number;
  /** Gain factor 0-2 (Voice tab "Lautstärke"). Default 1. */
  volume?: number;
}

/** Effects that need ffmpeg; 1 (or unset) means "leave as is". */
function effectsRequested(opts: TranscodeAudioOptions): boolean {
  return [opts.tempo, opts.pitch, opts.volume].some((v) => v !== undefined && Math.abs(v - 1) > 0.001);
}

function clampFactor(value: number | undefined, min: number, max: number): number {
  return value === undefined || !Number.isFinite(value) ? 1 : Math.min(max, Math.max(min, value));
}

/** Post-concat filter chain for speed/pitch/volume. Pitch = resample trick + inverse tempo. */
function effectFilters(opts: TranscodeAudioOptions, sampleRate: number): string[] {
  const tempo = clampFactor(opts.tempo, 0.5, 2);
  const pitch = clampFactor(opts.pitch, 0.5, 2);
  const volume = clampFactor(opts.volume, 0, 2);
  const filters: string[] = [];
  if (Math.abs(pitch - 1) > 0.001) {
    filters.push(`asetrate=${Math.round(sampleRate * pitch)}`, `aresample=${sampleRate}`);
  }
  // Undo the speed change asetrate introduced; atempo only takes 0.5-2 per instance, so chain.
  let atempo = tempo / pitch;
  while (atempo > 2) { filters.push("atempo=2"); atempo /= 2; }
  while (atempo < 0.5) { filters.push("atempo=0.5"); atempo /= 0.5; }
  if (Math.abs(atempo - 1) > 0.001) filters.push(`atempo=${atempo.toFixed(4)}`);
  if (Math.abs(volume - 1) > 0.001) filters.push(`volume=${volume.toFixed(3)}`);
  return filters;
}

export interface TranscodeAudioResult {
  audio: Buffer;
  mimeType: string;
  /** Which path produced the file - useful for diagnostics in plugin UIs. */
  engine: "ffmpeg" | "passthrough" | "wav-concat";
}

const MIME_FOR_FORMAT: Record<AudioExportFormat, string> = { wav: "audio/wav", mp3: "audio/mpeg" };
const EXT_BY_MIME: Record<string, string> = {
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/vnd.wave": "wav",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/ogg": "ogg", "audio/opus": "opus",
  "audio/flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a", "audio/webm": "webm",
};
/** Hard cap for one export job - an hour of speech encodes in seconds, so this only stops hangs. */
const FFMPEG_TIMEOUT_MS = 5 * 60_000;

function baseMime(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

function formatOfMime(mimeType: string): AudioExportFormat | undefined {
  const ext = EXT_BY_MIME[baseMime(mimeType)];
  return ext === "wav" || ext === "mp3" ? ext : undefined;
}

export async function isFfmpegAvailable(): Promise<boolean> {
  return Boolean(await findFfmpeg());
}

interface WavPcm {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Buffer;
}

/** Minimal RIFF/WAVE reader: returns the fmt fields and the data chunk, or undefined. */
function parseWav(buf: Buffer): WavPcm | undefined {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return undefined;
  let offset = 12;
  let fmt: Omit<WavPcm, "data"> | undefined;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    let size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data" && fmt) {
      // Streaming encoders write 0 / 0xFFFFFFFF as size; take the rest of the buffer then.
      if (size === 0 || body + size > buf.length) size = buf.length - body;
      return { ...fmt, data: buf.subarray(body, body + size) };
    }
    offset = body + size + (size % 2);
  }
  return undefined;
}

function buildWav(fmt: Omit<WavPcm, "data">, data: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const blockAlign = (fmt.channels * fmt.bitsPerSample) / 8;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(fmt.audioFormat, 20);
  header.writeUInt16LE(fmt.channels, 22);
  header.writeUInt32LE(fmt.sampleRate, 24);
  header.writeUInt32LE(fmt.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(fmt.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** JS fallback: concatenates PCM WAV clips that share one format, or returns undefined. */
function concatWavClips(clips: AudioClip[], opts: TranscodeAudioOptions): Buffer | undefined {
  const parsed = clips.map((clip) => parseWav(clip.audio));
  if (parsed.some((p) => !p || p.audioFormat !== 1)) return undefined;
  const first = parsed[0]!;
  const sameFormat = parsed.every((p) => p!.channels === first.channels && p!.sampleRate === first.sampleRate && p!.bitsPerSample === first.bitsPerSample);
  if (!sameFormat) return undefined;
  if ((opts.sampleRate && opts.sampleRate !== first.sampleRate) || (opts.channels && opts.channels !== first.channels)) return undefined;
  const blockAlign = (first.channels * first.bitsPerSample) / 8;
  const gapBytes = Math.round(((opts.gapMs ?? 0) / 1000) * first.sampleRate) * blockAlign;
  const parts: Buffer[] = [];
  parsed.forEach((p, i) => {
    parts.push(p!.data);
    if (gapBytes > 0 && i < parsed.length - 1) parts.push(Buffer.alloc(gapBytes));
  });
  return buildWav(first, Buffer.concat(parts));
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { windowsHide: true, timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const tail = String(stderr).trim().split(/\r?\n/).slice(-3).join(" | ");
      reject(new Error(`ffmpeg failed: ${tail || error.message}`));
    });
  });
}

async function transcodeWithFfmpeg(ffmpegPath: string, clips: AudioClip[], opts: TranscodeAudioOptions): Promise<Buffer> {
  const workDir = await mkdtemp(join(tmpdir(), "ducki-tts-"));
  try {
    const args = ["-hide_banner", "-loglevel", "error", "-y"];
    for (let i = 0; i < clips.length; i++) {
      const inPath = join(workDir, `in-${i}.${EXT_BY_MIME[baseMime(clips[i]!.mimeType)] ?? "bin"}`);
      await writeFile(inPath, clips[i]!.audio);
      args.push("-i", inPath);
    }
    // Normalize every clip to one rate/layout so concat never rejects mismatched inputs
    // (a provider may switch rate between chunks), pad all but the last with the gap.
    const rate = opts.sampleRate ?? 0;
    const layout = opts.channels === 1 ? "mono" : opts.channels === 2 ? "stereo" : "";
    const gapSec = Math.max(0, (opts.gapMs ?? 0) / 1000);
    const chains = clips.map((_, i) => {
      const filters = [
        rate ? `aresample=${rate}` : "",
        `aformat=sample_fmts=s16${rate ? `:sample_rates=${rate}` : ""}${layout ? `:channel_layouts=${layout}` : ""}`,
        gapSec > 0 && i < clips.length - 1 ? `apad=pad_dur=${gapSec}` : "",
      ].filter(Boolean).join(",");
      return `[${i}:a]${filters}[a${i}]`;
    });
    const inputs = clips.map((_, i) => `[a${i}]`).join("");
    // asetrate needs the actual rate; without an explicit target, force a known one.
    const effects = effectFilters(opts, rate || 24000);
    const needsRate = effects.some((f) => f.startsWith("asetrate")) && !rate;
    const post = [...(needsRate ? ["aresample=24000"] : []), ...effects].join(",");
    const graph = post
      ? `${chains.join(";")};${inputs}concat=n=${clips.length}:v=0:a=1[cat];[cat]${post}[out]`
      : `${chains.join(";")};${inputs}concat=n=${clips.length}:v=0:a=1[out]`;
    args.push("-filter_complex", graph, "-map", "[out]");
    if (opts.format === "mp3") args.push("-c:a", "libmp3lame", "-b:a", `${opts.bitrateKbps ?? 192}k`);
    else args.push("-c:a", "pcm_s16le");
    const outPath = join(workDir, `out.${opts.format}`);
    args.push(outPath);
    await runFfmpeg(ffmpegPath, args);
    return await readFile(outPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function transcodeAudio(clips: AudioClip[], opts: TranscodeAudioOptions): Promise<TranscodeAudioResult> {
  if (clips.length === 0) throw new Error("transcodeAudio: no audio clips given");
  if (opts.format !== "wav" && opts.format !== "mp3") throw new Error(`transcodeAudio: unsupported format '${String(opts.format)}'`);
  const mimeType = MIME_FOR_FORMAT[opts.format];

  // A single clip already in the target format needs no work unless WAV parameters change
  // (MP3 bitrate is not re-checked: re-encoding an MP3 only loses quality).
  if (clips.length === 1 && !effectsRequested(opts) && formatOfMime(clips[0]!.mimeType) === opts.format && (opts.format === "mp3" || (!opts.sampleRate && !opts.channels))) {
    return { audio: clips[0]!.audio, mimeType, engine: "passthrough" };
  }

  const ffmpegPath = await findFfmpeg();
  if (ffmpegPath) return { audio: await transcodeWithFfmpeg(ffmpegPath, clips, opts), mimeType, engine: "ffmpeg" };

  if (opts.format === "wav" && !effectsRequested(opts)) {
    const joined = concatWavClips(clips, opts);
    if (joined) return { audio: joined, mimeType, engine: "wav-concat" };
  }
  throw new Error(
    "ffmpeg wird für diese Konvertierung benötigt (z. B. MP3-Export, gemischte Formate, Tempo/Tonhöhe/Lautstärke), ist aber nicht installiert. " +
      "Installiere die ffmpeg-Komponente in den Einstellungen oder wähle WAV als Exportformat."
  );
}
