/**
 * Video attachment pipeline: turns an uploaded video into what a text+vision model can
 * actually use -- an audio transcript (nodejs-whisper, same pipeline as
 * apps/server/src/lib/audio-transcription.ts) plus a handful of evenly-spaced frames
 * (ffmpeg), NOT every frame. Feeding a model 1 frame/sec of a multi-minute clip would blow
 * the context window and the vision cost for no benefit -- a sparse set of frames plus the
 * full spoken transcript covers "what was said" and "roughly what was shown" without that.
 *
 * ffmpeg-static/ffprobe-static ship prebuilt binaries per-platform, so unlike the sharp
 * dynamic-import in agent.ts's compressImageBuffer() this is a hard dependency: without a
 * working ffmpeg there is no way to process video at all, so failures here are logged and
 * surfaced as "video analysis unavailable" rather than silently skipped.
 */
import ffmpeg from "fluent-ffmpeg";
import ffmpegPathModule from "ffmpeg-static";
// @ts-expect-error ffprobe-static ships no type declarations
import ffprobeStatic from "ffprobe-static";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { createSpeechToTextProvider } from "@ducki/providers";

const ffmpegPath = ffmpegPathModule as unknown as string | null;
const ffprobePath = (ffprobeStatic as { path?: string } | null)?.path;
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);

/** Cap on sampled frames -- keeps vision cost/context bounded regardless of video length. */
const MAX_FRAMES = 6;
/** Frames are downscaled to this max edge length before being sent to the model. */
const FRAME_MAX_DIM = 768;
/** Hard cap on how much of a video is actually processed -- protects against a runaway
 *  ffmpeg job on an accidentally-huge upload; anything past this is simply not sampled. */
const MAX_DURATION_SEC = 180;
/** Guard against absurdly large uploads before even touching ffmpeg. */
const MAX_INPUT_BYTES = 80 * 1024 * 1024;

export interface VideoFrame {
  timestampSec: number;
  buffer: Buffer;
}

export interface VideoAnalysis {
  transcript: string;
  durationSec: number;
  frames: VideoFrame[];
  /** True when the video was longer than MAX_DURATION_SEC and only sampled up to that point. */
  truncated: boolean;
}

/** Mirrors transcribeAudioBuffer() in apps/server/src/lib/audio-transcription.ts -- kept as
 *  a small local copy rather than a cross-package import so packages/agent doesn't need to
 *  depend on apps/server (wrong dependency direction). Both read the same DB settings keys. */
async function transcribeExtractedAudio(db: DatabaseService, audioBuffer: Buffer): Promise<string> {
  const allSettings = await db.getAllSettings();
  const settings = new Map(allSettings.map((s) => [s.key, s.value]));
  const read = (key: string, fallback?: string) => settings.get(key) || fallback;
  const readBool = (key: string, fallback: boolean) => {
    const raw = read(key);
    if (raw === undefined) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
  };

  const provider = createSpeechToTextProvider({
    name: "nodejs-whisper",
    model: read("NODEJS_WHISPER_MODEL_NAME", "base"),
    modelRootPath: read("NODEJS_WHISPER_MODEL_ROOT_PATH"),
    autoDownloadModel: readBool("NODEJS_WHISPER_AUTO_DOWNLOAD", true),
    withCuda: readBool("NODEJS_WHISPER_USE_CUDA", false),
    timeoutMs: Number.parseInt(read("NODEJS_WHISPER_TIMEOUT_MS", "180000") ?? "180000", 10),
  });

  const result = await provider.transcribe(audioBuffer, { language: "de" });
  let text = "";
  if (typeof result === "string") {
    text = result.trim();
  } else if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    text = String(obj["text"] ?? obj["transcript"] ?? result).trim();
  } else {
    text = String(result).trim();
  }
  return text.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/gm, "").trim();
}

function probeDurationSec(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err: Error | null, data: { format?: { duration?: number } }) => {
      if (err) return reject(err);
      resolve(data?.format?.duration ?? 0);
    });
  });
}

function extractAudioWav(inputPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .save(outPath);
  });
}

function extractFrameAt(inputPath: string, timestampSec: number, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(timestampSec)
      .frames(1)
      .videoFilters(`scale='min(${FRAME_MAX_DIM},iw)':'min(${FRAME_MAX_DIM},ih)':force_original_aspect_ratio=decrease`)
      .outputOptions(["-q:v 4"])
      .format("mjpeg")
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .save(outPath);
  });
}

async function extractSampledFrames(inputPath: string, durationSec: number, workDir: string, logger: Logger): Promise<VideoFrame[]> {
  // Roughly 1 frame per 10s of content, capped at MAX_FRAMES either way.
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(durationSec / 10) || 1));
  const frames: VideoFrame[] = [];
  for (let i = 0; i < count; i++) {
    // Evenly spaced across the (possibly truncated) duration, offset by half a slice so the
    // first/last sample isn't sitting on a black opening/closing frame.
    const fraction = count === 1 ? 0.5 : (i + 0.5) / count;
    const timestampSec = Math.max(0, Math.min(durationSec * fraction, durationSec - 0.1));
    const outPath = join(workDir, `frame-${i}.jpg`);
    try {
      await extractFrameAt(inputPath, timestampSec, outPath);
      frames.push({ timestampSec, buffer: await readFile(outPath) });
    } catch (error) {
      logger.warn("Video frame extraction failed", {
        timestampSec,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return frames;
}

/** Returns null (rather than throwing) when the video can't be analyzed at all -- e.g. too
 *  large, or ffmpeg missing/failing -- so callers can fall back to treating it as a plain
 *  unprocessed attachment instead of failing the whole turn. */
export async function analyzeVideo(db: DatabaseService, logger: Logger, videoBuffer: Buffer): Promise<VideoAnalysis | null> {
  if (!ffmpegPath) {
    logger.warn("ffmpeg-static binary not available, skipping video analysis");
    return null;
  }
  if (videoBuffer.length > MAX_INPUT_BYTES) {
    logger.warn("Video attachment exceeds size cap, skipping analysis", {
      sizeBytes: videoBuffer.length,
      capBytes: MAX_INPUT_BYTES,
    });
    return null;
  }

  const workDir = await mkdtemp(join(tmpdir(), "ducki-video-"));
  const inputPath = join(workDir, "input");
  const audioPath = join(workDir, "audio.wav");

  try {
    await writeFile(inputPath, videoBuffer);

    let durationSec = 0;
    try {
      durationSec = await probeDurationSec(inputPath);
    } catch (error) {
      logger.warn("ffprobe failed, continuing without a known duration", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const truncated = durationSec > MAX_DURATION_SEC;
    const sampleDurationSec = truncated ? MAX_DURATION_SEC : durationSec || MAX_DURATION_SEC;

    const [transcript, frames] = await Promise.all([
      extractAudioWav(inputPath, audioPath)
        .then(() => readFile(audioPath))
        .then((wavBuffer) => transcribeExtractedAudio(db, wavBuffer))
        .catch((error) => {
          logger.warn("Video audio transcription failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return "";
        }),
      extractSampledFrames(inputPath, sampleDurationSec, workDir, logger),
    ]);

    return { transcript, durationSec: durationSec || sampleDurationSec, frames, truncated };
  } catch (error) {
    logger.warn("Video analysis failed", { error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
