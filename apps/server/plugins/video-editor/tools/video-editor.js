/**
 * Agentic video editor (trust: "node"). Projects contain uploaded clips, a single ordered
 * timeline (cut list of `clip` and/or `scene` items), timeline-relative captions + freeform
 * overlays (text/shapes), extra mixed-in audio tracks, and background render jobs - all in the
 * plugin's own SQLite. Mirrors social-media's plugin conventions (projects-containing-items,
 * ctx.storage, ctx.agent, base64-in/data-route-out for media).
 *
 * A `scene` timeline item has NO uploaded footage - its video is generated (solid color,
 * two-color gradient, or a looped static image), matching the "agent composes a video from an
 * idea, no source footage" workflow: title cards, section breaks, narrated-text-over-background
 * segments. `add_title_card` is a one-call convenience for the common case (scene + centered
 * text overlay spanning it).
 *
 * ffmpeg setup mirrors packages/agent/src/media/video-processing.ts (ffmpeg-static/ffprobe-static
 * + fluent-ffmpeg for probing/thumbnails/audio-extraction). The RENDER itself (per-item trim/
 * generate + scale/pad + effects, transition-aware concat/xfade fold, caption/overlay burn-in,
 * extra audio mixing) is built and run as a raw ffmpeg child process with an explicit argv array
 * (see runFfmpegArgs) - every individual filter technique below was verified against the real
 * bundled ffmpeg-static.exe before being wired in:
 *   - drawtext with an inline `text=...` value and backslash-escaped colons/apostrophes is
 *     UNRELIABLE in this exact ffmpeg build (mis-parses once a colon AND an apostrophe appear in
 *     the same value, inside a chained filter_complex). The technique that verified reliably -
 *     and is used for both captions and text overlays - is `drawtext=textfile=<relative-file>`
 *     with the text written to its own temp .txt file and the ffmpeg process's cwd set to that
 *     temp folder (no drive-letter colon to escape at all).
 *   - rect shapes: `drawbox` (native filter, no font dependency, verified directly).
 *   - circle/ellipse shapes: no native ffmpeg filter draws one, and `sharp` isn't installed in
 *     this repo (a true optional dep elsewhere) - verified instead via a `color` lavfi source +
 *     `geq` alpha-masked ellipse formula, composited with `overlay` (enable=between(t,...)).
 *   - gradient scene backgrounds: same `geq` technique, this time as a linear R/G/B interpolation
 *     between two hex colors across X (horizontal) or Y (vertical) - verified directly; NOT
 *     generated as a PNG (no sharp available), a deliberate deviation from the "sharp PNG" idea.
 *   - transitions: `xfade` (video) + `acrossfade` (audio), chained pairwise across the timeline.
 *     Requires matching input timebases - clips at different source frame rates made xfade fail
 *     ("timebase does not match") until an explicit `fps=30` normalization was added to every
 *     per-item video chain (kept unconditionally, not just when a transition is present, since it
 *     also makes plain concat more robust across mixed-fps sources).
 *   - effects: `eq` (brightness/contrast/saturation), `gblur` (blur), `fade` (fade_in/fade_out and
 *     the fade_to_black transition), `setpts`+`atempo` (speed - atempo only covers 0.5-2.0 per
 *     instance, so speed is clamped to that range rather than chaining multiple instances).
 *   - extra audio tracks: `adelay` (position) + `volume` + pairwise `amix`.
 * No PNG/sharp fallback was needed anywhere - every technique above verified working directly.
 *
 * Transcription does NOT go through ctx.agent.transcribeAudio() (that returns plain text with
 * timestamps stripped) - captions need real start/end times, so transcribe_clip calls
 * createSpeechToTextProvider() itself (same "nodejs-whisper" provider transcribeExtractedAudio()
 * in video-processing.ts uses) and parses the `[00:00:00.000 --> 00:00:02.500]` lines into
 * segments instead of stripping them. Whisper settings are read from this plugin's OWN settings
 * (provides.settings in plugin.json, same defaults as the core pipeline) rather than the global
 * DB settings table - a trust:"node" plugin's ctx has no `db` handle, only its own settings
 * store, so this is the closest equivalent without a core change.
 */

import ffmpeg from "fluent-ffmpeg";
import ffmpegPathModule from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import {
  mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, rmSync,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createSpeechToTextProvider } from "@ducki/providers";

const execFileAsync = promisify(execFile);

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIPS_DIR = join(PLUGIN_DIR, "data", "clips");
const RENDERS_DIR = join(PLUGIN_DIR, "data", "renders");
const BACKGROUNDS_DIR = join(PLUGIN_DIR, "data", "backgrounds");
const AUDIO_DIR = join(PLUGIN_DIR, "data", "audio");
const TMP_DIR = join(PLUGIN_DIR, "data", ".tmp");

const ffmpegPath = /** @type {string | null} */ (ffmpegPathModule);
const ffprobePath = /** @type {{path?: string} | null} */ (ffprobeStatic)?.path;
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);

const THUMB_MAX_DIM = 480;
const DEFAULT_RENDER_WIDTH = 1280;
const DEFAULT_RENDER_HEIGHT = 720;
const MIN_SPEED = 0.5;
const MAX_SPEED = 2.0;

export const definition = {
  name: "video_editor",
  description:
    "Agentischer Video-Editor: Clips hochladen ODER generierte Szenen (Farbe/Verlauf/Bild, ohne Footage) auf einer Timeline anordnen, trimmen, mit Uebergaengen/Effekten versehen, Text-/Formen-Overlays und Untertitel platzieren, zusaetzliche Audiospuren einmischen, fertigen Schnitt rendern. " +
    "action=add_project (name) / list_projects / delete_project (id). " +
    "action=add_clip (project_id, video_base64, original_name?) laedt einen Clip hoch, probet Dauer/Aufloesung, erzeugt ein Thumbnail. " +
    "action=list_clips (project_id) / get_clip (id) / delete_clip (id). " +
    "action=transcribe_clip (clip_id) erzeugt ein ZEITGESTEMPELTES Transkript (Whisper). " +
    "action=analyze_clip (clip_id, question?) liefert eine KI-Szenen-/Inhaltsbeschreibung. " +
    "action=suggest_highlight (clip_id) laesst die KI den staerksten Moment vorschlagen. " +
    "action=get_timeline (project_id) / set_timeline (project_id, items) - items=[{type:'clip', clip_id, source_start_sec, source_end_sec, order, transition_out?, effects?} | {type:'scene', duration_sec, background:{kind:'color'|'gradient'|'image', value}, order, transition_out?, effects?}], ersetzt die gesamte Schnittliste. transition_out={type:'none'|'crossfade'|'wipe'|'fade_to_black', duration_sec} gilt zwischen diesem Item und dem naechsten. effects=[{type:'fade_in'|'fade_out'|'brightness'|'contrast'|'saturation'|'blur'|'speed', value?, duration_sec?}]. " +
    "action=add_scene_background_image (project_id, image_base64, original_name?) laedt ein Bild fuer background.kind='image' hoch (value=zurueckgegebene background_id). " +
    "action=add_title_card (project_id, text, duration_sec?, background_color?, order?) Komfort-Action: erzeugt in EINEM Aufruf eine Szene + zentriertes Text-Overlay (Titelkarte). " +
    "action=generate_captions_from_clip (project_id, clip_id, timeline_offset_sec) erzeugt Untertitel aus dem Transkript eines Clips, verschoben um seine Timeline-Position. " +
    "action=list_captions / add_caption (project_id, start_sec, end_sec, text, pos_x?, pos_y?) / update_caption (id, ..., pos_x?, pos_y?) / delete_caption (id). pos_x/pos_y sind Prozent-Position (0-100, Default 50/88) - nur pos_y wirkt sich aufs gerenderte Video aus, solange pos_x beim Default 50 bleibt (horizontal zentriert); sobald pos_x veraendert wird, wird links-buendig anhand von pos_x gerendert. " +
    "action=add_overlay (project_id, type:'text'|'shape', start_sec, end_sec, x, y, width?, height?, z_index?, track_index?, props) - x/y/width/height in PROZENT (0-100) der Zielaufloesung (width/height ohne Angabe: Default 30x10 fuer Text, 20x20 fuer Formen). track_index (Default 0) ist rein eine UI-Spur-Gruppierung, hat KEINEN Effekt auf das Rendering. props text: {content, font_size?, color?, background_color?, align?}. props shape: {shape_type:'rect'|'circle', color, opacity?, stroke_width?}. " +
    "action=list_overlays / update_overlay (id, ..., track_index?) / delete_overlay (id). " +
    "action=add_audio_track (project_id, audio_base64, start_sec, volume?, track_index?, original_name?) mischt eine zusaetzliche Audiodatei an einer Timeline-Position ein (track_index: reine UI-Spur-Gruppierung, Default 0, kein Render-Effekt). " +
    "action=list_audio_tracks / update_audio_track (id, start_sec?, volume?, track_index?) / delete_audio_track (id). " +
    "action=render (project_id, options?: {burn_captions}) startet den Export im HINTERGRUND, gibt sofort {render_id} zurueck - Fortschritt mit get_render abfragen. " +
    "action=get_render (id) / list_renders (project_id).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "add_project", "list_projects", "delete_project",
          "add_clip", "list_clips", "get_clip", "delete_clip",
          "transcribe_clip", "analyze_clip", "suggest_highlight",
          "get_timeline", "set_timeline",
          "add_scene_background_image", "add_title_card",
          "generate_captions_from_clip", "list_captions", "add_caption", "update_caption", "delete_caption",
          "add_overlay", "list_overlays", "update_overlay", "delete_overlay",
          "add_audio_track", "list_audio_tracks", "update_audio_track", "delete_audio_track",
          "render", "get_render", "list_renders",
        ],
      },
      id: { type: "number", description: "Id des jeweiligen Objekts (Projekt/Clip/Caption/Overlay/AudioTrack/Render), je nach action" },
      name: { type: "string", description: "Projektname (add_project)" },
      project_id: { type: "number", description: "Projekt-Id" },
      clip_id: { type: "number", description: "Clip-Id" },
      video_base64: { type: "string", description: "Video als Base64 (roh oder data:-URL) (add_clip)" },
      original_name: { type: "string", description: "Urspruenglicher Dateiname (fuer Dateiendung), optional" },
      question: { type: "string", description: "Frage/Fokus fuer die Analyse (analyze_clip, optional)" },
      items: { type: "array", description: "Geordnete Schnittliste (set_timeline), siehe Tool-Beschreibung fuer die Item-Form.", items: { type: "object" } },
      timeline_offset_sec: { type: "number", description: "Timeline-Position in Sekunden (generate_captions_from_clip)" },
      start_sec: { type: "number", description: "Start in Sekunden (Timeline-relativ)" },
      end_sec: { type: "number", description: "Ende in Sekunden (Timeline-relativ)" },
      text: { type: "string", description: "Text (Untertitel, add_title_card)" },
      duration_sec: { type: "number", description: "Dauer in Sekunden (add_title_card)" },
      background_color: { type: "string", description: "Hex-Farbe (add_title_card, optional)" },
      order: { type: "number", description: "Position (add_title_card, optional)" },
      image_base64: { type: "string", description: "Bild als Base64 (add_scene_background_image)" },
      overlay_type: { type: "string", enum: ["text", "shape"], description: "add_overlay" },
      type: { type: "string", description: "Overlay-Typ ('text'|'shape') fuer add_overlay - alias von overlay_type" },
      x: { type: "number", description: "X-Position in Prozent (0-100) der Zielaufloesung" },
      y: { type: "number", description: "Y-Position in Prozent (0-100)" },
      width: { type: "number", description: "Breite in Prozent (0-100), optional" },
      height: { type: "number", description: "Hoehe in Prozent (0-100), optional" },
      z_index: { type: "number", description: "Stapelreihenfolge, optional" },
      track_index: { type: "number", description: "UI-Spur-Nummer (Overlays/Audiospuren), Default 0, reine Anzeige-Gruppierung ohne Render-Effekt" },
      props: { type: "object", description: "Typ-spezifische Overlay-Eigenschaften, siehe Tool-Beschreibung" },
      audio_base64: { type: "string", description: "Audiodatei als Base64 (add_audio_track)" },
      volume: { type: "number", description: "Lautstaerke-Faktor (add_audio_track/update_audio_track, Default 1)" },
      pos_x: { type: "number", description: "Untertitel-X-Position in Prozent (0-100, Default 50), add_caption/update_caption" },
      pos_y: { type: "number", description: "Untertitel-Y-Position in Prozent (0-100, Default 88), add_caption/update_caption" },
      options: { type: "object", description: "Render-Optionen (render)", properties: { burn_captions: { type: "boolean" } } },
    },
    required: ["action"],
  },
};

// ----------------------------------------------------------------------------------------------
// Schema
// ----------------------------------------------------------------------------------------------

async function ensureSchema(storage) {
  await storage.exec("CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL)");
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS clips (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, filename TEXT, original_name TEXT, " +
      "duration_sec REAL, width INTEGER, height INTEGER, thumbnail_data_url TEXT, transcript_segments_json TEXT, ai_summary TEXT, " +
      "status TEXT NOT NULL DEFAULT 'processing', error TEXT, created_at TEXT NOT NULL)"
  );
  await storage.exec("CREATE TABLE IF NOT EXISTS timeline (project_id INTEGER PRIMARY KEY, items_json TEXT NOT NULL)");
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS captions (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, start_sec REAL NOT NULL, end_sec REAL NOT NULL, " +
      "text TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)"
  );
  // Additive migrations for columns introduced after the original CREATE TABLE - safe to run
  // unconditionally on every startup (ALTER TABLE ADD COLUMN throws "duplicate column" once the
  // column already exists, which is swallowed here) so existing installs pick them up too.
  try { await storage.exec("ALTER TABLE captions ADD COLUMN pos_x REAL NOT NULL DEFAULT 50"); } catch (e) { /* already applied */ }
  try { await storage.exec("ALTER TABLE captions ADD COLUMN pos_y REAL NOT NULL DEFAULT 88"); } catch (e) { /* already applied */ }
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS overlays (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, type TEXT NOT NULL, " +
      "start_sec REAL NOT NULL, end_sec REAL NOT NULL, x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0, " +
      "width REAL, height REAL, z_index INTEGER NOT NULL DEFAULT 0, props_json TEXT NOT NULL, created_at TEXT NOT NULL)"
  );
  try { await storage.exec("ALTER TABLE overlays ADD COLUMN track_index INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* already applied */ }
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS audio_tracks (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, filename TEXT NOT NULL, original_name TEXT, " +
      "start_sec REAL NOT NULL DEFAULT 0, volume REAL NOT NULL DEFAULT 1, created_at TEXT NOT NULL)"
  );
  try { await storage.exec("ALTER TABLE audio_tracks ADD COLUMN track_index INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* already applied */ }
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS backgrounds (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, filename TEXT NOT NULL, original_name TEXT, created_at TEXT NOT NULL)"
  );
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS renders (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', " +
      "output_filename TEXT, error TEXT, created_at TEXT NOT NULL, completed_at TEXT)"
  );
}

const CAPTION_COLUMNS = 'id, project_id, start_sec, end_sec, text, pos_x, pos_y, sort_order AS "order", created_at';
const OVERLAY_COLUMNS = "id, project_id, type, start_sec, end_sec, x, y, width, height, z_index, track_index, props_json, created_at";
const AUDIO_TRACK_COLUMNS = "id, project_id, filename, original_name, start_sec, volume, track_index, created_at";

function overlayRowToApi(row) {
  if (!row) return row;
  const { props_json, ...rest } = row;
  let props = {};
  try { props = JSON.parse(props_json || "{}"); } catch { props = {}; }
  return { ...rest, props };
}

// ----------------------------------------------------------------------------------------------
// Small ffmpeg/ffprobe helpers (mirrors packages/agent/src/media/video-processing.ts's setup)
// ----------------------------------------------------------------------------------------------

function ffprobeAsync(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

async function probeClip(filePath) {
  const data = await ffprobeAsync(filePath);
  const durationSec = data?.format?.duration ?? 0;
  const videoStream = (data?.streams || []).find((s) => s.codec_type === "video");
  const hasAudio = (data?.streams || []).some((s) => s.codec_type === "audio");
  return {
    durationSec,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    hasAudio,
  };
}

function extractFrameAt(inputPath, timestampSec, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(Math.max(0, timestampSec))
      .frames(1)
      .videoFilters(`scale='min(${THUMB_MAX_DIM},iw)':'min(${THUMB_MAX_DIM},ih)':force_original_aspect_ratio=decrease`)
      .outputOptions(["-q:v 4"])
      .format("mjpeg")
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .save(outPath);
  });
}

async function generateThumbnail(inputPath, durationSec) {
  const workDir = await mkdtemp(join(tmpdir(), "video-editor-thumb-"));
  const outPath = join(workDir, "thumb.jpg");
  try {
    const at = Math.min(Math.max(0, (durationSec || 1) * 0.1), Math.max(0, (durationSec || 1) - 0.1));
    await extractFrameAt(inputPath, at, outPath);
    const buffer = await readFile(outPath);
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function extractAudioWav(inputPath, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .save(outPath);
  });
}

// ----------------------------------------------------------------------------------------------
// Whisper transcription with TIMESTAMPS (own call, not ctx.agent.transcribeAudio - that strips
// them). Reads this plugin's OWN settings (see plugin.json provides.settings) with the same
// defaults the core pipeline uses, since a trust:"node" plugin's ctx has no `db` handle to read
// the global settings table the way transcribeExtractedAudio() does.
// ----------------------------------------------------------------------------------------------

function buildWhisperProvider(settings) {
  return createSpeechToTextProvider({
    name: "nodejs-whisper",
    model: String(settings["NODEJS_WHISPER_MODEL_NAME"] ?? "base"),
    modelRootPath: settings["NODEJS_WHISPER_MODEL_ROOT_PATH"] || undefined,
    autoDownloadModel: settings["NODEJS_WHISPER_AUTO_DOWNLOAD"] !== false,
    withCuda: settings["NODEJS_WHISPER_USE_CUDA"] === true,
    timeoutMs: Number(settings["NODEJS_WHISPER_TIMEOUT_MS"] ?? 180000),
  });
}

/** Parses nodejs-whisper's `[00:00:00.000 --> 00:00:02.500]  text` lines into timed segments -
 *  the one piece transcribeExtractedAudio()'s regex throws away (it strips these to get plain
 *  text). Lines without a recognizable timestamp are skipped (nothing to time them against). */
function parseTimestampedSegments(rawText) {
  const lineRe = /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]\s*(.*)$/;
  const toSec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  const segments = [];
  for (const line of String(rawText || "").split(/\r?\n/)) {
    const m = lineRe.exec(line.trim());
    if (!m) continue;
    const text = m[9].trim();
    if (!text) continue;
    segments.push({
      startSec: toSec(m[1], m[2], m[3], m[4]),
      endSec: toSec(m[5], m[6], m[7], m[8]),
      text,
    });
  }
  return segments;
}

async function transcribeClipFile(filePath, settings) {
  const workDir = await mkdtemp(join(tmpdir(), "video-editor-wav-"));
  const wavPath = join(workDir, "audio.wav");
  try {
    await extractAudioWav(filePath, wavPath);
    const wavBuffer = await readFile(wavPath);
    const provider = buildWhisperProvider(settings);
    const result = await provider.transcribe(wavBuffer, { language: "de" });
    const text = typeof result === "string" ? result : String(result?.text ?? result?.transcript ?? result ?? "");
    return parseTimestampedSegments(text);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ----------------------------------------------------------------------------------------------
// File helpers
// ----------------------------------------------------------------------------------------------

function extFromOriginalName(name) {
  if (!name) return undefined;
  const ext = extname(String(name)).replace(/^\./, "").toLowerCase();
  return ext || undefined;
}
function extFromDataUrl(base64, kind) {
  const m = /^data:([\w/-]+);base64,/.exec(String(base64 || ""));
  if (!m) return undefined;
  const videoMap = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv" };
  const imageMap = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
  const audioMap = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/aac": "aac", "audio/mp4": "m4a" };
  const map = kind === "image" ? imageMap : kind === "audio" ? audioMap : videoMap;
  return map[m[1]];
}
function decodeBase64(input) {
  const raw = String(input || "");
  const m = /^data:[\w/-]+;base64,(.*)$/s.exec(raw);
  return Buffer.from(m ? m[1] : raw, "base64");
}

function clipAbsPath(filename) { return join(CLIPS_DIR, filename); }
function renderAbsPath(filename) { return join(RENDERS_DIR, filename); }
function backgroundAbsPath(filename) { return join(BACKGROUNDS_DIR, filename); }
function audioAbsPath(filename) { return join(AUDIO_DIR, filename); }

function removeIfExists(path) {
  if (path && existsSync(path)) {
    try { unlinkSync(path); } catch { /* best effort */ }
  }
}

// ----------------------------------------------------------------------------------------------
// Timeline item helpers (shared by render + add_title_card's offset computation)
// ----------------------------------------------------------------------------------------------

function normalizeTransition(t) {
  if (!t || typeof t !== "object") return { type: "none", duration_sec: 0 };
  const type = ["none", "crossfade", "wipe", "fade_to_black"].includes(t.type) ? t.type : "none";
  return { type, duration_sec: Math.max(0, Number(t.duration_sec) || 0.5) };
}
function speedFactorOf(item) {
  const fx = (item.effects || []).find((e) => e && e.type === "speed");
  if (!fx || fx.value == null) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number(fx.value) || 1));
}
/** Raw (pre-speed) duration of one timeline item. */
function itemRawDuration(item) {
  if (item.type === "scene") return Math.max(0.05, Number(item.duration_sec) || 1);
  const start = Math.max(0, Number(item.source_start_sec) || 0);
  const end = Math.max(start + 0.05, Number(item.source_end_sec) || start + 0.05);
  return end - start;
}
function itemEffectiveDuration(item) {
  return itemRawDuration(item) / speedFactorOf(item);
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  const v = m ? m[1] : "808080";
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) };
}
function normalizeColor(hex, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  return m ? `#${m[1]}` : fallback || "#ffffff";
}

// ----------------------------------------------------------------------------------------------
// Render pipeline
// ----------------------------------------------------------------------------------------------

function runFfmpegArgs(args, cwd) {
  return execFileAsync(ffmpegPath, args, { cwd, maxBuffer: 1024 * 1024 * 20 });
}

function evenDim(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

/** eq/blur/fade filter fragments derived from an item's `effects` array (speed is handled
 *  separately via setpts/atempo since it also changes duration). */
function buildEffectFragments(effects, effectiveDurationSec) {
  const fragments = [];
  const eqParts = [];
  for (const fx of effects || []) {
    if (!fx || typeof fx !== "object") continue;
    if (fx.type === "brightness") eqParts.push(`brightness=${Number(fx.value ?? 0.1)}`);
    if (fx.type === "contrast") eqParts.push(`contrast=${Number(fx.value ?? 1.2)}`);
    if (fx.type === "saturation") eqParts.push(`saturation=${Number(fx.value ?? 1.3)}`);
  }
  if (eqParts.length > 0) fragments.push(`eq=${eqParts.join(":")}`);
  for (const fx of effects || []) {
    if (!fx || typeof fx !== "object") continue;
    if (fx.type === "blur") fragments.push(`gblur=sigma=${Math.max(0.1, Number(fx.value ?? 5))}`);
    if (fx.type === "fade_in") fragments.push(`fade=t=in:st=0:d=${Math.max(0.05, Number(fx.duration_sec ?? 0.5))}`);
    if (fx.type === "fade_out") {
      const d = Math.max(0.05, Number(fx.duration_sec ?? 0.5));
      fragments.push(`fade=t=out:st=${Math.max(0, effectiveDurationSec - d).toFixed(3)}:d=${d}`);
    }
  }
  return fragments;
}

/** Builds one timeline item's own input args + video/audio filter chains (BEFORE it's folded
 *  into the running concat/xfade chain). `idx` is this item's ffmpeg input index. */
async function buildItemSegment(item, idx, clipsById, backgroundsById, width, height) {
  const speed = speedFactorOf(item);
  const effects = item.effects || [];
  const inputArgs = [];
  let videoFragments = [];
  let audioLine;
  let effectiveDurationSec;

  if (item.type === "scene") {
    const durationSec = Math.max(0.05, Number(item.duration_sec) || 1);
    effectiveDurationSec = durationSec / speed;
    const bg = item.background || { kind: "color", value: "#111318" };
    if (bg.kind === "image") {
      const bgRow = backgroundsById[Number(bg.value)];
      if (!bgRow || !existsSync(backgroundAbsPath(bgRow.filename))) throw new Error(`Szenen-Hintergrundbild ${bg.value} nicht gefunden`);
      inputArgs.push("-loop", "1", "-t", durationSec.toFixed(3), "-i", backgroundAbsPath(bgRow.filename));
      videoFragments.push(`setpts=(PTS-STARTPTS)/${speed}`, `scale=${width}:${height}:force_original_aspect_ratio=decrease`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, "setsar=1");
    } else if (bg.kind === "gradient") {
      const from = hexToRgb(bg.value?.from || "#0ea5e9");
      const to = hexToRgb(bg.value?.to || "#8b5cf6");
      const axis = bg.value?.direction === "vertical" ? "(Y/H)" : "(X/W)";
      inputArgs.push("-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:d=${durationSec.toFixed(3)}`);
      videoFragments.push(
        `geq=r='(1-${axis})*${from.r}+${axis}*${to.r}':g='(1-${axis})*${from.g}+${axis}*${to.g}':b='(1-${axis})*${from.b}+${axis}*${to.b}'`,
        `setpts=(PTS-STARTPTS)/${speed}`
      );
    } else {
      const color = normalizeColor(bg.value, "#111318");
      inputArgs.push("-f", "lavfi", "-i", `color=c=${color}:s=${width}x${height}:d=${durationSec.toFixed(3)}`);
      videoFragments.push(`setpts=(PTS-STARTPTS)/${speed}`);
    }
    audioLine = `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${effectiveDurationSec.toFixed(3)}`;
  } else {
    const clip = clipsById[item.clip_id];
    if (!clip || !clip.filename) throw new Error(`Clip ${item.clip_id} nicht gefunden oder ohne Datei`);
    const absPath = clipAbsPath(clip.filename);
    if (!existsSync(absPath)) throw new Error(`Clip-Datei fehlt auf der Festplatte: ${clip.filename}`);
    inputArgs.push("-i", absPath);

    const start = Math.max(0, Number(item.source_start_sec) || 0);
    const end = Math.max(start + 0.05, Number(item.source_end_sec) || start + 0.05);
    effectiveDurationSec = (end - start) / speed;

    videoFragments.push(`trim=start=${start}:end=${end}`, `setpts=(PTS-STARTPTS)/${speed}`, `scale=${width}:${height}:force_original_aspect_ratio=decrease`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, "setsar=1");

    let hasAudio = clip.hasAudio;
    if (hasAudio === undefined) {
      try { hasAudio = (await probeClip(absPath)).hasAudio; } catch { hasAudio = false; }
    }
    if (hasAudio) {
      const atempoPart = speed !== 1 ? `,atempo=${speed}` : "";
      audioLine = `[${idx}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS${atempoPart}[a${idx}]`;
    } else {
      audioLine = `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${effectiveDurationSec.toFixed(3)}`;
    }
  }

  videoFragments.push("fps=30", "format=yuv420p", ...buildEffectFragments(effects, effectiveDurationSec));

  return {
    inputArgs,
    videoFragments,
    audioLine: audioLine.startsWith("anullsrc") ? `${audioLine}[a${idx}]` : audioLine,
    effectiveDurationSec,
  };
}

/** Builds the full -filter_complex graph for one render: per-item chains -> transition-aware
 *  pairwise fold (plain concat, or xfade/acrossfade for crossfade/wipe) -> caption/overlay
 *  burn-in -> extra audio track mixing. `capDir`, when any text is burned in, is where per-caption/
 *  overlay .txt files are written - drawtext references them by RELATIVE filename (module doc
 *  comment), so the ffmpeg process's cwd must equal capDir. */
async function buildRenderFilterGraph(items, clipsById, backgroundsById, captions, overlays, audioTracks, burnCaptions, capDir) {
  const firstClip = items[0].type === "clip" ? clipsById[items[0].clip_id] : null;
  const width = evenDim(firstClip?.width || DEFAULT_RENDER_WIDTH);
  const height = evenDim(firstClip?.height || DEFAULT_RENDER_HEIGHT);

  const inputs = [];
  const filterParts = [];
  const segments = [];
  // ffmpeg indexes inputs by "-i" OCCURRENCE, not by CLI-token count - `inputs` holds flat
  // tokens (some items push extra flags like "-f lavfi" or "-loop 1 -t N" before their "-i"),
  // so the [N:v]/[N:a] label index has to be tracked separately from inputs.length.
  let inputCount = 0;

  // fade_to_black has no xfade/concat-graph effect of its own (unlike crossfade/wipe, it does
  // NOT overlap the two segments) - it's just an auto fade-out on the item before the boundary
  // and an auto fade-in on the item after, so it's implemented by injecting synthetic fade_out/
  // fade_in effects into the adjacent items' own effects list before their chains are built.
  const effectiveItems = items.map((it) => ({ ...it, effects: Array.isArray(it.effects) ? [...it.effects] : [] }));
  for (let i = 0; i < effectiveItems.length - 1; i++) {
    const transition = normalizeTransition(effectiveItems[i].transition_out);
    if (transition.type !== "fade_to_black") continue;
    effectiveItems[i].effects.push({ type: "fade_out", duration_sec: transition.duration_sec });
    effectiveItems[i + 1].effects.push({ type: "fade_in", duration_sec: transition.duration_sec });
  }

  for (let i = 0; i < effectiveItems.length; i++) {
    const seg = await buildItemSegment(effectiveItems[i], inputCount, clipsById, backgroundsById, width, height);
    const inputIdx = inputCount;
    for (const arg of seg.inputArgs) inputs.push(arg);
    inputCount++;
    filterParts.push(`[${inputIdx}:v]${seg.videoFragments.join(",")}[v${inputIdx}]`);
    filterParts.push(seg.audioLine);
    segments.push({ videoLabel: `v${inputIdx}`, audioLabel: `a${inputIdx}`, effectiveDurationSec: seg.effectiveDurationSec });
  }

  // Fold pairwise: plain concat for 'none'/'fade_to_black' (fade_to_black's own fade in/out was
  // already baked into the adjacent items' fragments below), xfade+acrossfade for crossfade/wipe.
  //
  // Both `concat` and `xfade` itself reset their output's timebase (concat typically produces a
  // much finer one, e.g. 1/1000000) - verified this breaks a LATER xfade in the same chain with
  // "First input link main timebase ... do not match the corresponding second input link xfade
  // timebase" even though every per-item chain already normalizes to fps=30 individually. Fix:
  // re-normalize with `fps=30` after every fold step's video output, not just once per item.
  let runningV = segments[0].videoLabel;
  let runningA = segments[0].audioLabel;
  let runningDur = segments[0].effectiveDurationSec;
  for (let i = 1; i < segments.length; i++) {
    const transition = normalizeTransition(items[i - 1].transition_out);
    const seg = segments[i];
    if (transition.type === "crossfade" || transition.type === "wipe") {
      const d = Math.max(0.05, Math.min(transition.duration_sec, runningDur - 0.05, seg.effectiveDurationSec - 0.05));
      const xType = transition.type === "wipe" ? "wipeleft" : "fade";
      const rawV = `xvraw${i}`, nv = `xv${i}`, na = `xa${i}`;
      filterParts.push(`[${runningV}][${seg.videoLabel}]xfade=transition=${xType}:duration=${d.toFixed(3)}:offset=${Math.max(0, runningDur - d).toFixed(3)}[${rawV}]`);
      filterParts.push(`[${rawV}]fps=30,format=yuv420p[${nv}]`);
      filterParts.push(`[${runningA}][${seg.audioLabel}]acrossfade=d=${d.toFixed(3)}[${na}]`);
      runningV = nv; runningA = na;
      runningDur = runningDur + seg.effectiveDurationSec - d;
    } else {
      const rawV = `cvraw${i}`, nv = `cv${i}`, na = `ca${i}`;
      filterParts.push(`[${runningV}][${runningA}][${seg.videoLabel}][${seg.audioLabel}]concat=n=2:v=1:a=1[${rawV}][${na}]`);
      filterParts.push(`[${rawV}]fps=30,format=yuv420p[${nv}]`);
      runningV = nv; runningA = na;
      runningDur = runningDur + seg.effectiveDurationSec;
    }
  }

  // --- Burn in captions + text/shape overlays (timeline-relative), captions on top -----------
  let videoLabel = runningV;
  if (burnCaptions) {
    let textFileIdx = 0;
    let shapeLavfiCount = 0;
    const drawItems = [
      ...overlays.map((o) => ({ kind: "overlay", ...o })),
      // x/y come from each caption's own pos_x/pos_y (draggable in the UI) instead of a fixed
      // literal. align stays "center" (full-frame horizontal centering, ignoring x - see the
      // xExpr branch below) ONLY while pos_x is still exactly the untouched default of 50, so a
      // caption nobody has ever dragged renders byte-for-byte the same as before pos_x/pos_y
      // existed. The moment a caption is dragged horizontally, align switches to "left" so x
      // actually drives the drawtext position - otherwise pos_x would be a stored-but-inert
      // field and the horizontal drag handle in the UI would visibly lie about having any effect.
      ...captions.map((c) => ({
        kind: "caption", type: "text", start_sec: c.start_sec, end_sec: c.end_sec,
        x: c.pos_x, y: c.pos_y, width: 90, height: 10, z_index: 1000,
        props: {
          content: c.text, font_size: Math.round(height * 0.045), color: "#ffffff", background_color: "#000000",
          align: Number(c.pos_x) === 50 ? "center" : "left",
        },
      })),
    ].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));

    for (const draw of drawItems) {
      const start = Math.max(0, Number(draw.start_sec) || 0);
      const end = Math.max(start + 0.05, Number(draw.end_sec) || start + 0.05);
      const enable = `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
      if (draw.type === "text") {
        const props = draw.props || {};
        const fileName = `txt_${textFileIdx++}.txt`;
        writeFileSync(join(capDir, fileName), String(props.content ?? ""), "utf8");
        const fontSize = Math.max(8, Number(props.font_size) || Math.round(height * 0.045));
        const color = normalizeColor(props.color, "#ffffff");
        const align = props.align || "center";
        const xExpr = align === "center" ? "(w-text_w)/2" : `(${Number(draw.x) || 0}/100)*w`;
        const yExpr = `(${Number(draw.y) || 0}/100)*h`;
        const boxPart = props.background_color ? `:box=1:boxcolor=${normalizeColor(props.background_color, "#000000")}@0.6:boxborderw=8` : "";
        const nv = `dt${textFileIdx}`;
        filterParts.push(`[${videoLabel}]drawtext=textfile=${fileName}:fontsize=${fontSize}:fontcolor=${color}${boxPart}:x=${xExpr}:y=${yExpr}:${enable}[${nv}]`);
        videoLabel = nv;
      } else {
        const props = draw.props || {};
        const px = Math.round((Number(draw.x) || 0) / 100 * width);
        const py = Math.round((Number(draw.y) || 0) / 100 * height);
        const pw = Math.max(2, Math.round((Number(draw.width) || 20) / 100 * width));
        const ph = Math.max(2, Math.round((Number(draw.height) || 20) / 100 * height));
        const opacity = props.opacity != null ? Math.max(0, Math.min(1, Number(props.opacity))) : 0.6;
        const color = normalizeColor(props.color, "#ff0000");
        if (props.shape_type === "circle") {
          const rgb = hexToRgb(color);
          const alpha = Math.round(opacity * 255);
          const lavfiIdx = inputCount; // append a new -i AFTER all timeline-item inputs
          inputs.push("-f", "lavfi", "-i", `color=c=black:s=${pw}x${ph}:d=1`);
          inputCount++;
          shapeLavfiCount++;
          const cx = pw / 2, cy = ph / 2, rx = pw / 2, ry = ph / 2;
          const circLabel = `circ${shapeLavfiCount}`;
          filterParts.push(
            `[${lavfiIdx}:v]geq=r='${rgb.r}':g='${rgb.g}':b='${rgb.b}':a='if(lte(pow(X-${cx},2)/pow(${rx},2)+pow(Y-${cy},2)/pow(${ry},2),1),${alpha},0)',format=yuva420p[${circLabel}]`
          );
          const nv = `ov${textFileIdx}_${shapeLavfiCount}`;
          // eof_action=repeat: the circle's lavfi source is a short 1s clip (its pixels never
          // change), repeated for as long as `enable` keeps it visible - avoids needing the
          // lavfi source's own duration to match the shape's on-screen time exactly.
          filterParts.push(`[${videoLabel}][${circLabel}]overlay=x=${px}:y=${py}:eof_action=repeat:${enable}[${nv}]`);
          videoLabel = nv;
        } else {
          const strokeW = props.stroke_width != null ? Math.max(1, Number(props.stroke_width)) : 0;
          const boxStyle = strokeW > 0 ? `t=${strokeW}` : "t=fill";
          const nv = `db${shapeLavfiCount}_${textFileIdx}`;
          filterParts.push(`[${videoLabel}]drawbox=x=${px}:y=${py}:w=${pw}:h=${ph}:color=${color}@${opacity}:${boxStyle}:${enable}[${nv}]`);
          videoLabel = nv;
        }
      }
    }
  }

  // --- Mix in extra audio tracks (adelay + volume + pairwise amix) ---------------------------
  let audioLabel = runningA;
  if (audioTracks.length > 0) {
    for (let i = 0; i < audioTracks.length; i++) {
      const track = audioTracks[i];
      const absPath = audioAbsPath(track.filename);
      if (!existsSync(absPath)) continue;
      const inputIdx = inputCount;
      inputs.push("-i", absPath);
      inputCount++;
      const delayMs = Math.max(0, Math.round((Number(track.start_sec) || 0) * 1000));
      const vol = Number(track.volume) || 1;
      const trackLabel = `atk${i}`;
      filterParts.push(`[${inputIdx}:a]volume=${vol},adelay=${delayMs}|${delayMs}[${trackLabel}]`);
      const nv = `mix${i}`;
      filterParts.push(`[${audioLabel}][${trackLabel}]amix=inputs=2:duration=first:dropout_transition=0[${nv}]`);
      audioLabel = nv;
    }
  }

  return { inputs, filterComplex: filterParts.join(";"), videoLabel, audioLabel };
}

async function runRenderJob(renderId, projectId, items, captions, overlays, audioTracks, clipsById, backgroundsById, burnCaptions, storage, logger) {
  const outputFilename = `${renderId}.mp4`;
  const outputPath = renderAbsPath(outputFilename);
  const jobDir = join(TMP_DIR, `render-${renderId}`);
  mkdirSync(jobDir, { recursive: true });
  mkdirSync(RENDERS_DIR, { recursive: true });

  const markDone = async (error) => {
    await storage.exec("UPDATE renders SET status='done', output_filename=?, error=?, completed_at=? WHERE id=?", [
      outputFilename, error ?? null, new Date().toISOString(), renderId,
    ]);
  };
  const markError = async (message) => {
    await storage.exec("UPDATE renders SET status='error', error=?, completed_at=? WHERE id=?", [message, new Date().toISOString(), renderId]);
  };

  try {
    await storage.exec("UPDATE renders SET status='rendering' WHERE id=?", [renderId]);

    const attempt = async (withText) => {
      const { inputs, filterComplex, videoLabel, audioLabel } = await buildRenderFilterGraph(
        items, clipsById, backgroundsById, withText ? captions : [], withText ? overlays : [], audioTracks, withText, jobDir
      );
      const args = ["-y"];
      for (const arg of inputs) args.push(arg);
      args.push(
        "-filter_complex", filterComplex,
        "-map", `[${videoLabel}]`, "-map", `[${audioLabel}]`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        outputPath
      );
      await runFfmpegArgs(args, jobDir);
    };

    const wantsText = burnCaptions && (captions.length > 0 || overlays.length > 0);
    try {
      await attempt(wantsText);
      await markDone(undefined);
    } catch (error) {
      if (wantsText) {
        logger?.warn?.("video-editor: render with burned-in text/overlays failed, retrying without them", {
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          await attempt(false);
          await markDone(
            `Untertitel/Overlay-Einbrennen fehlgeschlagen, Video wurde ohne gerendert: ${error instanceof Error ? error.message : String(error)}`
          );
        } catch (secondError) {
          await markError(secondError instanceof Error ? secondError.message : String(secondError));
        }
      } else {
        await markError(error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    await markError(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------------------------------
// Actions - clips
// ----------------------------------------------------------------------------------------------

async function addClip(input, storage) {
  const projectId = Number(input.project_id);
  if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
  if (!input.video_base64) return { error: "video_base64 ist erforderlich" };

  const now = new Date().toISOString();
  const [clip] = await storage.query(
    "INSERT INTO clips (project_id, original_name, status, created_at) VALUES (?, ?, 'processing', ?) RETURNING *",
    [projectId, input.original_name ?? null, now]
  );

  try {
    const buffer = decodeBase64(input.video_base64);
    if (buffer.length === 0) throw new Error("video_base64 ist leer/ungueltig");
    const ext = extFromOriginalName(input.original_name) || extFromDataUrl(input.video_base64, "video") || "mp4";
    const filename = `${clip.id}.${ext}`;
    mkdirSync(CLIPS_DIR, { recursive: true });
    writeFileSync(clipAbsPath(filename), buffer);

    const probe = await probeClip(clipAbsPath(filename));
    const thumbnail = await generateThumbnail(clipAbsPath(filename), probe.durationSec).catch(() => null);

    await storage.exec(
      "UPDATE clips SET filename=?, duration_sec=?, width=?, height=?, thumbnail_data_url=?, status='ready' WHERE id=?",
      [filename, probe.durationSec, probe.width, probe.height, thumbnail, clip.id]
    );
    const [updated] = await storage.query("SELECT * FROM clips WHERE id = ?", [clip.id]);
    return { clip: updated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await storage.exec("UPDATE clips SET status='error', error=? WHERE id=?", [message, clip.id]);
    return { error: message, clip_id: clip.id };
  }
}

async function transcribeClip(input, storage, settings) {
  const clipId = Number(input.clip_id);
  if (!Number.isFinite(clipId)) return { error: "clip_id ist erforderlich" };
  const [clip] = await storage.query("SELECT * FROM clips WHERE id = ?", [clipId]);
  if (!clip) return { error: "Clip nicht gefunden" };
  if (!clip.filename || !existsSync(clipAbsPath(clip.filename))) return { error: "Clip-Datei nicht (mehr) vorhanden" };

  try {
    const segments = await transcribeClipFile(clipAbsPath(clip.filename), settings);
    await storage.exec("UPDATE clips SET transcript_segments_json=? WHERE id=?", [JSON.stringify(segments), clipId]);
    return { clip_id: clipId, segments };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Transkription fehlgeschlagen: ${message}` };
  }
}

async function analyzeClip(input, storage, agent) {
  const clipId = Number(input.clip_id);
  if (!Number.isFinite(clipId)) return { error: "clip_id ist erforderlich" };
  const [clip] = await storage.query("SELECT * FROM clips WHERE id = ?", [clipId]);
  if (!clip) return { error: "Clip nicht gefunden" };
  if (!clip.filename || !existsSync(clipAbsPath(clip.filename))) return { error: "Clip-Datei nicht (mehr) vorhanden" };

  const question = String(input.question || "").trim() ||
    "Beschreibe kurz Szene, Inhalt und Stimmung dieses Video-Clips (was ist zu sehen und zu hoeren?).";
  try {
    const buffer = readFileSync(clipAbsPath(clip.filename));
    const result = await agent.analyzeVideo(buffer, question);
    await storage.exec("UPDATE clips SET ai_summary=? WHERE id=?", [result.analysis ?? null, clipId]);
    return { clip_id: clipId, ai_summary: result.analysis, transcript: result.transcript, duration_sec: result.durationSec };
  } catch (error) {
    return { error: `Analyse fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function suggestHighlight(input, storage, agent) {
  const clipId = Number(input.clip_id);
  if (!Number.isFinite(clipId)) return { error: "clip_id ist erforderlich" };
  const [clip] = await storage.query("SELECT * FROM clips WHERE id = ?", [clipId]);
  if (!clip) return { error: "Clip nicht gefunden" };
  if (!clip.filename || !existsSync(clipAbsPath(clip.filename))) return { error: "Clip-Datei nicht (mehr) vorhanden" };

  const prompt =
    "Identifiziere den einzelnen staerksten/interessantesten Moment in diesem Clip fuer einen kurzen Highlight-Schnitt. " +
    "Antworte mit Start- und Endzeit in Sekunden (z.B. 'Start: 4.5s, Ende: 9.0s') plus einem kurzen Satz zur Begruendung.";
  try {
    const buffer = readFileSync(clipAbsPath(clip.filename));
    const result = await agent.analyzeVideo(buffer, prompt);
    const raw = result.analysis || "";
    const numbers = (raw.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => Number(n.replace(",", ".")));
    if (numbers.length >= 2) {
      const start = Math.min(numbers[0], numbers[1]);
      const end = Math.max(numbers[0], numbers[1]);
      const duration = result.durationSec || clip.duration_sec || end;
      return {
        clip_id: clipId,
        start_sec: Math.max(0, Math.min(start, duration)),
        end_sec: Math.max(0, Math.min(end, duration)),
        raw,
      };
    }
    return { clip_id: clipId, hint: raw };
  } catch (error) {
    return { error: `Highlight-Vorschlag fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ----------------------------------------------------------------------------------------------
// Actions - scene backgrounds, title card
// ----------------------------------------------------------------------------------------------

async function addSceneBackgroundImage(input, storage) {
  const projectId = Number(input.project_id);
  if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
  if (!input.image_base64) return { error: "image_base64 ist erforderlich" };
  const now = new Date().toISOString();
  const [row] = await storage.query(
    "INSERT INTO backgrounds (project_id, filename, original_name, created_at) VALUES (?, '', ?, ?) RETURNING *",
    [projectId, input.original_name ?? null, now]
  );
  try {
    const buffer = decodeBase64(input.image_base64);
    if (buffer.length === 0) throw new Error("image_base64 ist leer/ungueltig");
    const ext = extFromOriginalName(input.original_name) || extFromDataUrl(input.image_base64, "image") || "png";
    const filename = `${row.id}.${ext}`;
    mkdirSync(BACKGROUNDS_DIR, { recursive: true });
    writeFileSync(backgroundAbsPath(filename), buffer);
    await storage.exec("UPDATE backgrounds SET filename=? WHERE id=?", [filename, row.id]);
    return { background: { ...row, filename } };
  } catch (error) {
    await storage.exec("DELETE FROM backgrounds WHERE id=?", [row.id]);
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function addTitleCard(input, storage) {
  const projectId = Number(input.project_id);
  if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
  const text = String(input.text || "").trim();
  if (!text) return { error: "text ist erforderlich" };
  const durationSec = Math.max(0.5, Number(input.duration_sec) || 3);
  const bgColor = normalizeColor(input.background_color, "#111318");

  const [timelineRow] = await storage.query("SELECT items_json FROM timeline WHERE project_id = ?", [projectId]);
  const items = timelineRow ? JSON.parse(timelineRow.items_json || "[]") : [];
  const sorted = [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const offset = sorted.reduce((sum, it) => sum + itemEffectiveDuration(it), 0);

  const orderVal = input.order != null ? Number(input.order) : sorted.length;
  const sceneItem = { type: "scene", duration_sec: durationSec, background: { kind: "color", value: bgColor }, order: orderVal };
  const newItems = [...sorted, sceneItem].map((it, idx) => ({ ...it, order: idx }));

  const existing = await storage.query("SELECT project_id FROM timeline WHERE project_id = ?", [projectId]);
  if (existing.length > 0) {
    await storage.exec("UPDATE timeline SET items_json = ? WHERE project_id = ?", [JSON.stringify(newItems), projectId]);
  } else {
    await storage.exec("INSERT INTO timeline (project_id, items_json) VALUES (?, ?)", [projectId, JSON.stringify(newItems)]);
  }

  const now = new Date().toISOString();
  const [overlay] = await storage.query(
    `INSERT INTO overlays (project_id, type, start_sec, end_sec, x, y, width, height, z_index, props_json, created_at) VALUES (?, 'text', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${OVERLAY_COLUMNS}`,
    [projectId, offset, offset + durationSec, 10, 40, 80, 20, 10, JSON.stringify({ content: text, font_size: 48, color: "#ffffff", align: "center" }), now]
  );
  return { scene_item: sceneItem, overlay: overlayRowToApi(overlay), timeline_offset_sec: offset, timeline: newItems };
}

// ----------------------------------------------------------------------------------------------
// Actions - captions, overlays, audio tracks
// ----------------------------------------------------------------------------------------------

async function generateCaptionsFromClip(input, storage) {
  const projectId = Number(input.project_id);
  const clipId = Number(input.clip_id);
  const offset = Number(input.timeline_offset_sec) || 0;
  if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
  if (!Number.isFinite(clipId)) return { error: "clip_id ist erforderlich" };

  const [clip] = await storage.query("SELECT * FROM clips WHERE id = ?", [clipId]);
  if (!clip) return { error: "Clip nicht gefunden" };
  const segments = JSON.parse(clip.transcript_segments_json || "[]");
  if (segments.length === 0) return { error: "Clip hat noch kein zeitgestempeltes Transkript - zuerst transcribe_clip aufrufen." };

  const [{ maxOrder } = { maxOrder: -1 }] = await storage.query(
    "SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM captions WHERE project_id = ?",
    [projectId]
  );
  const now = new Date().toISOString();
  const created = [];
  let order = (maxOrder ?? -1) + 1;
  for (const seg of segments) {
    const [row] = await storage.query(
      `INSERT INTO captions (project_id, start_sec, end_sec, text, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING ${CAPTION_COLUMNS}`,
      [projectId, seg.startSec + offset, seg.endSec + offset, seg.text, order, now]
    );
    created.push(row);
    order++;
  }
  return { count: created.length, captions: created };
}

// Default box size (percent) for a newly created overlay when width/height aren't given - the
// schema allows both to be null (no size = nothing concrete to see or drag-resize from in the
// UI), so pick a sane starting box per type instead of leaving it null.
const OVERLAY_DEFAULT_SIZE = { text: { width: 30, height: 10 }, shape: { width: 20, height: 20 } };

async function addOverlay(input, storage) {
  const projectId = Number(input.project_id);
  if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
  const type = input.overlay_type || input.type;
  if (!["text", "shape"].includes(type)) return { error: "type/overlay_type muss 'text' oder 'shape' sein" };
  const now = new Date().toISOString();
  const defaultSize = OVERLAY_DEFAULT_SIZE[type];
  const [row] = await storage.query(
    `INSERT INTO overlays (project_id, type, start_sec, end_sec, x, y, width, height, z_index, track_index, props_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${OVERLAY_COLUMNS}`,
    [
      projectId, type,
      Number(input.start_sec) || 0, Number(input.end_sec) || 0,
      Number(input.x) || 0, Number(input.y) || 0,
      input.width != null ? Number(input.width) : defaultSize.width,
      input.height != null ? Number(input.height) : defaultSize.height,
      input.z_index != null ? Number(input.z_index) : 0,
      input.track_index != null ? Number(input.track_index) : 0,
      JSON.stringify(input.props || {}), now,
    ]
  );
  return { overlay: overlayRowToApi(row) };
}

async function startRender(input, storage, logger) {
  const projectId = Number(input.project_id);
  if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };

  const [timelineRow] = await storage.query("SELECT items_json FROM timeline WHERE project_id = ?", [projectId]);
  const items = timelineRow ? JSON.parse(timelineRow.items_json || "[]") : [];
  if (items.length === 0) return { error: "Timeline ist leer - zuerst set_timeline aufrufen." };
  const sortedItems = [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((it) => ({ type: "clip", ...it }));

  const clips = await storage.query("SELECT * FROM clips WHERE project_id = ?", [projectId]);
  const clipsById = Object.fromEntries(clips.map((c) => [c.id, c]));
  const backgrounds = await storage.query("SELECT * FROM backgrounds WHERE project_id = ?", [projectId]);
  const backgroundsById = Object.fromEntries(backgrounds.map((b) => [b.id, b]));
  for (const item of sortedItems) {
    if (item.type === "clip" && !clipsById[item.clip_id]) return { error: `Timeline referenziert unbekannten Clip ${item.clip_id}` };
    if (item.type === "scene" && item.background?.kind === "image" && !backgroundsById[Number(item.background.value)]) {
      return { error: `Timeline referenziert unbekanntes Szenen-Hintergrundbild ${item.background.value}` };
    }
  }

  const burnCaptions = !!(input.options && input.options.burn_captions);
  const captions = await storage.query(`SELECT ${CAPTION_COLUMNS} FROM captions WHERE project_id = ? ORDER BY sort_order ASC`, [projectId]);
  const overlayRows = await storage.query(`SELECT ${OVERLAY_COLUMNS} FROM overlays WHERE project_id = ? ORDER BY z_index ASC`, [projectId]);
  const overlays = overlayRows.map(overlayRowToApi);
  const audioTracks = await storage.query(`SELECT ${AUDIO_TRACK_COLUMNS} FROM audio_tracks WHERE project_id = ?`, [projectId]);

  const now = new Date().toISOString();
  const [render] = await storage.query(
    "INSERT INTO renders (project_id, status, created_at) VALUES (?, 'queued', ?) RETURNING *",
    [projectId, now]
  );

  // Fire-and-forget: do NOT await - a multi-clip/multi-transition render can take a while and
  // must not block this tool call / the HTTP request that triggered it. Poll via get_render.
  void runRenderJob(render.id, projectId, sortedItems, captions, overlays, audioTracks, clipsById, backgroundsById, burnCaptions, storage, logger).catch((error) => {
    logger?.error?.("video-editor: unhandled render job failure", { error: error instanceof Error ? error.message : String(error) });
  });

  return { render_id: render.id, status: "queued" };
}

// ----------------------------------------------------------------------------------------------
// execute()
// ----------------------------------------------------------------------------------------------

export async function execute(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  await ensureSchema(storage);
  mkdirSync(CLIPS_DIR, { recursive: true });
  mkdirSync(RENDERS_DIR, { recursive: true });
  mkdirSync(BACKGROUNDS_DIR, { recursive: true });
  mkdirSync(AUDIO_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });

  const action = input.action;

  // --- Projects -------------------------------------------------------------------------------
  if (action === "add_project") {
    if (!input.name) return { error: "name ist erforderlich" };
    const [project] = await storage.query("INSERT INTO projects (name, created_at) VALUES (?, ?) RETURNING *", [input.name, new Date().toISOString()]);
    return { added: true, project };
  }
  if (action === "list_projects") {
    const projects = await storage.query("SELECT * FROM projects ORDER BY name ASC");
    return { count: projects.length, projects };
  }
  if (action === "delete_project") {
    const id = Number(input.id);
    if (!Number.isFinite(id)) return { error: "id ist erforderlich" };
    const clips = await storage.query("SELECT * FROM clips WHERE project_id = ?", [id]);
    for (const clip of clips) removeIfExists(clip.filename && clipAbsPath(clip.filename));
    const renders = await storage.query("SELECT * FROM renders WHERE project_id = ?", [id]);
    for (const render of renders) removeIfExists(render.output_filename && renderAbsPath(render.output_filename));
    const backgrounds = await storage.query("SELECT * FROM backgrounds WHERE project_id = ?", [id]);
    for (const bg of backgrounds) removeIfExists(bg.filename && backgroundAbsPath(bg.filename));
    const audioTracks = await storage.query("SELECT * FROM audio_tracks WHERE project_id = ?", [id]);
    for (const track of audioTracks) removeIfExists(track.filename && audioAbsPath(track.filename));
    await storage.exec("DELETE FROM clips WHERE project_id = ?", [id]);
    await storage.exec("DELETE FROM captions WHERE project_id = ?", [id]);
    await storage.exec("DELETE FROM overlays WHERE project_id = ?", [id]);
    await storage.exec("DELETE FROM audio_tracks WHERE project_id = ?", [id]);
    await storage.exec("DELETE FROM backgrounds WHERE project_id = ?", [id]);
    await storage.exec("DELETE FROM renders WHERE project_id = ?", [id]);
    await storage.exec("DELETE FROM timeline WHERE project_id = ?", [id]);
    await storage.exec("DELETE FROM projects WHERE id = ?", [id]);
    return { ok: true };
  }

  // --- Clips ------------------------------------------------------------------------------------
  if (action === "add_clip") return addClip(input, storage);
  if (action === "list_clips") {
    const projectId = Number(input.project_id);
    if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
    const clips = await storage.query("SELECT * FROM clips WHERE project_id = ? ORDER BY created_at ASC", [projectId]);
    return { count: clips.length, clips };
  }
  if (action === "get_clip") {
    const id = Number(input.id);
    if (!Number.isFinite(id)) return { error: "id ist erforderlich" };
    const [clip] = await storage.query("SELECT * FROM clips WHERE id = ?", [id]);
    if (!clip) return { error: "Clip nicht gefunden" };
    return { clip };
  }
  if (action === "delete_clip") {
    const id = Number(input.id);
    if (!Number.isFinite(id)) return { error: "id ist erforderlich" };
    const [clip] = await storage.query("SELECT * FROM clips WHERE id = ?", [id]);
    if (clip) removeIfExists(clip.filename && clipAbsPath(clip.filename));
    await storage.exec("DELETE FROM clips WHERE id = ?", [id]);
    return { ok: true };
  }

  // --- Whisper/AI analysis (needs agent capabilities, trust:"node" only) ------------------------
  if (["analyze_clip", "suggest_highlight"].includes(action) && !ctx.agent) {
    return { error: "Agent-Capabilities (analyzeVideo) sind in diesem Kontext nicht verfuegbar." };
  }
  if (action === "transcribe_clip") return transcribeClip(input, storage, ctx.settings || {});
  if (action === "analyze_clip") return analyzeClip(input, storage, ctx.agent);
  if (action === "suggest_highlight") return suggestHighlight(input, storage, ctx.agent);

  // --- Timeline ---------------------------------------------------------------------------------
  if (action === "get_timeline") {
    const projectId = Number(input.project_id);
    if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
    const [row] = await storage.query("SELECT items_json FROM timeline WHERE project_id = ?", [projectId]);
    return { project_id: projectId, items: row ? JSON.parse(row.items_json || "[]") : [] };
  }
  if (action === "set_timeline") {
    const projectId = Number(input.project_id);
    if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
    const items = Array.isArray(input.items) ? input.items : [];
    const normalized = items.map((it, idx) => {
      const type = it.type === "scene" ? "scene" : "clip";
      const base = {
        type,
        order: it.order != null ? Number(it.order) : idx,
        transition_out: it.transition_out ? normalizeTransition(it.transition_out) : undefined,
        effects: Array.isArray(it.effects) ? it.effects : undefined,
      };
      if (type === "scene") {
        return { ...base, duration_sec: Number(it.duration_sec) || 1, background: it.background || { kind: "color", value: "#111318" } };
      }
      return { ...base, clip_id: Number(it.clip_id), source_start_sec: Number(it.source_start_sec) || 0, source_end_sec: Number(it.source_end_sec) || 0 };
    });
    const existing = await storage.query("SELECT project_id FROM timeline WHERE project_id = ?", [projectId]);
    if (existing.length > 0) {
      await storage.exec("UPDATE timeline SET items_json = ? WHERE project_id = ?", [JSON.stringify(normalized), projectId]);
    } else {
      await storage.exec("INSERT INTO timeline (project_id, items_json) VALUES (?, ?)", [projectId, JSON.stringify(normalized)]);
    }
    return { ok: true, items: normalized };
  }

  // --- Scene backgrounds / title card -------------------------------------------------------------
  if (action === "add_scene_background_image") return addSceneBackgroundImage(input, storage);
  if (action === "add_title_card") return addTitleCard(input, storage);

  // --- Captions -----------------------------------------------------------------------------------
  if (action === "generate_captions_from_clip") return generateCaptionsFromClip(input, storage);
  if (action === "list_captions") {
    const projectId = Number(input.project_id);
    if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
    const captions = await storage.query(`SELECT ${CAPTION_COLUMNS} FROM captions WHERE project_id = ? ORDER BY sort_order ASC`, [projectId]);
    return { count: captions.length, captions };
  }
  if (action === "add_caption") {
    const projectId = Number(input.project_id);
    if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
    const [{ maxOrder } = { maxOrder: -1 }] = await storage.query(
      "SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM captions WHERE project_id = ?",
      [projectId]
    );
    const [row] = await storage.query(
      `INSERT INTO captions (project_id, start_sec, end_sec, text, pos_x, pos_y, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${CAPTION_COLUMNS}`,
      [
        projectId, Number(input.start_sec) || 0, Number(input.end_sec) || 0, String(input.text || ""),
        input.pos_x != null ? Number(input.pos_x) : 50, input.pos_y != null ? Number(input.pos_y) : 88,
        (maxOrder ?? -1) + 1, new Date().toISOString(),
      ]
    );
    return { caption: row };
  }
  if (action === "update_caption") {
    const id = Number(input.id);
    if (!Number.isFinite(id)) return { error: "id ist erforderlich" };
    const [existing] = await storage.query("SELECT * FROM captions WHERE id = ?", [id]);
    if (!existing) return { error: "Caption nicht gefunden" };
    const startSec = input.start_sec != null ? Number(input.start_sec) : existing.start_sec;
    const endSec = input.end_sec != null ? Number(input.end_sec) : existing.end_sec;
    const text = input.text != null ? String(input.text) : existing.text;
    const posX = input.pos_x != null ? Number(input.pos_x) : existing.pos_x;
    const posY = input.pos_y != null ? Number(input.pos_y) : existing.pos_y;
    await storage.exec("UPDATE captions SET start_sec=?, end_sec=?, text=?, pos_x=?, pos_y=? WHERE id=?", [startSec, endSec, text, posX, posY, id]);
    const [row] = await storage.query(`SELECT ${CAPTION_COLUMNS} FROM captions WHERE id = ?`, [id]);
    return { caption: row };
  }
  if (action === "delete_caption") {
    const id = Number(input.id);
    if (!Number.isFinite(id)) return { error: "id ist erforderlich" };
    await storage.exec("DELETE FROM captions WHERE id = ?", [id]);
    return { ok: true };
  }

  // --- Overlays (text/shape) -----------------------------------------------------------------------
  if (action === "add_overlay") return addOverlay(input, storage);
  if (action === "list_overlays") {
    const projectId = Number(input.project_id);
    if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
    const rows = await storage.query(`SELECT ${OVERLAY_COLUMNS} FROM overlays WHERE project_id = ? ORDER BY z_index ASC, start_sec ASC`, [projectId]);
    return { count: rows.length, overlays: rows.map(overlayRowToApi) };
  }
  if (action === "update_overlay") {
    const id = Number(input.id);
    if (!Number.isFinite(id)) return { error: "id ist erforderlich" };
    const [existing] = await storage.query("SELECT * FROM overlays WHERE id = ?", [id]);
    if (!existing) return { error: "Overlay nicht gefunden" };
    const merged = {
      start_sec: input.start_sec != null ? Number(input.start_sec) : existing.start_sec,
      end_sec: input.end_sec != null ? Number(input.end_sec) : existing.end_sec,
      x: input.x != null ? Number(input.x) : existing.x,
      y: input.y != null ? Number(input.y) : existing.y,
      width: input.width != null ? Number(input.width) : existing.width,
      height: input.height != null ? Number(input.height) : existing.height,
      z_index: input.z_index != null ? Number(input.z_index) : existing.z_index,
      track_index: input.track_index != null ? Number(input.track_index) : existing.track_index,
      props_json: input.props != null ? JSON.stringify(input.props) : existing.props_json,
    };
    await storage.exec(
      "UPDATE overlays SET start_sec=?, end_sec=?, x=?, y=?, width=?, height=?, z_index=?, track_index=?, props_json=? WHERE id=?",
      [merged.start_sec, merged.end_sec, merged.x, merged.y, merged.width, merged.height, merged.z_index, merged.track_index, merged.props_json, id]
    );
    const [row] = await storage.query(`SELECT ${OVERLAY_COLUMNS} FROM overlays WHERE id = ?`, [id]);
    return { overlay: overlayRowToApi(row) };
  }
  if (action === "delete_overlay") {
    const id = Number(input.id);
    if (!Number.isFinite(id)) return { error: "id ist erforderlich" };
    await storage.exec("DELETE FROM overlays WHERE id = ?", [id]);
    return { ok: true };
  }

  // --- Audio tracks ------------------------------------------------------------------------------
  if (action === "add_audio_track") {
    const projectId = Number(input.project_id);
    if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
    if (!input.audio_base64) return { error: "audio_base64 ist erforderlich" };
    const now = new Date().toISOString();
    const [row] = await storage.query(
      "INSERT INTO audio_tracks (project_id, filename, original_name, start_sec, volume, track_index, created_at) VALUES (?, '', ?, ?, ?, ?, ?) RETURNING *",
      [projectId, input.original_name ?? null, Number(input.start_sec) || 0, input.volume != null ? Number(input.volume) : 1, input.track_index != null ? Number(input.track_index) : 0, now]
    );
    try {
      const buffer = decodeBase64(input.audio_base64);
      if (buffer.length === 0) throw new Error("audio_base64 ist leer/ungueltig");
      const ext = extFromOriginalName(input.original_name) || extFromDataUrl(input.audio_base64, "audio") || "mp3";
      const filename = `${row.id}.${ext}`;
      mkdirSync(AUDIO_DIR, { recursive: true });
      writeFileSync(audioAbsPath(filename), buffer);
      await storage.exec("UPDATE audio_tracks SET filename=? WHERE id=?", [filename, row.id]);
      const [updated] = await storage.query(`SELECT ${AUDIO_TRACK_COLUMNS} FROM audio_tracks WHERE id = ?`, [row.id]);
      return { audio_track: updated };
    } catch (error) {
      await storage.exec("DELETE FROM audio_tracks WHERE id=?", [row.id]);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (action === "list_audio_tracks") {
    const projectId = Number(input.project_id);
    if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
    const rows = await storage.query(`SELECT ${AUDIO_TRACK_COLUMNS} FROM audio_tracks WHERE project_id = ? ORDER BY start_sec ASC`, [projectId]);
    return { count: rows.length, audio_tracks: rows };
  }
  if (action === "update_audio_track") {
    const id = Number(input.id);
    if (!Number.isFinite(id)) return { error: "id ist erforderlich" };
    const [existing] = await storage.query("SELECT * FROM audio_tracks WHERE id = ?", [id]);
    if (!existing) return { error: "Audiospur nicht gefunden" };
    const startSec = input.start_sec != null ? Number(input.start_sec) : existing.start_sec;
    const volume = input.volume != null ? Number(input.volume) : existing.volume;
    const trackIndex = input.track_index != null ? Number(input.track_index) : existing.track_index;
    await storage.exec("UPDATE audio_tracks SET start_sec=?, volume=?, track_index=? WHERE id=?", [startSec, volume, trackIndex, id]);
    const [row] = await storage.query(`SELECT ${AUDIO_TRACK_COLUMNS} FROM audio_tracks WHERE id = ?`, [id]);
    return { audio_track: row };
  }
  if (action === "delete_audio_track") {
    const id = Number(input.id);
    if (!Number.isFinite(id)) return { error: "id ist erforderlich" };
    const [existing] = await storage.query("SELECT * FROM audio_tracks WHERE id = ?", [id]);
    if (existing) removeIfExists(existing.filename && audioAbsPath(existing.filename));
    await storage.exec("DELETE FROM audio_tracks WHERE id = ?", [id]);
    return { ok: true };
  }

  // --- Render ---------------------------------------------------------------------------------
  if (action === "render") return startRender(input, storage, ctx.logger);
  if (action === "get_render") {
    const id = Number(input.id);
    if (!Number.isFinite(id)) return { error: "id ist erforderlich" };
    const [render] = await storage.query("SELECT * FROM renders WHERE id = ?", [id]);
    if (!render) return { error: "Render nicht gefunden" };
    return { render };
  }
  if (action === "list_renders") {
    const projectId = Number(input.project_id);
    if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
    const renders = await storage.query("SELECT * FROM renders WHERE project_id = ? ORDER BY created_at DESC", [projectId]);
    return { count: renders.length, renders };
  }

  return { error: `Unbekannte action: ${action}` };
}
