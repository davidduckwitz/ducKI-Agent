/**
 * TTS-Studio module tool (trust: "node"). Turns text into a WAV/MP3 file through the host's
 * internal TTS pipeline (ctx.agent.speech - same engines and settings as the Voice tab).
 *
 * Long texts are split at paragraph/sentence boundaries into chunks of at most
 * max_chunk_chars, synthesized one after another (local engines run on one GPU) and joined by
 * ctx.agent.speech.transcode, which also converts to the export format. Exports are written
 * to this plugin's data/exports/ folder; their metadata lives in the plugin's own SQLite.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const EXPORT_DIR = fileURLToPath(new URL("../data/exports/", import.meta.url));
const MAX_TEXT_CHARS = 100_000;
const MAX_CHUNKS = 400;
const PROVIDERS = ["openai", "elevenlabs", "piper", "local", "chatterbox", "qwen3-tts", "pocket-tts", "breeze"];
/** Engines that clone from the shared reference-voice library (WAV clips). */
const REFERENCE_ENGINES = ["chatterbox", "qwen3-tts", "pocket-tts"];
const OPENAI_VOICES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
const MAX_REFERENCE_BYTES = 30 * 1024 * 1024;

export const definition = {
  name: "tts_studio",
  description:
    "Text in Sprache umwandeln und als Audiodatei (wav oder mp3) exportieren, über das interne TTS-System. " +
    "action=synthesize (text, format?, title?, provider?, voice?, language?) erzeugt und speichert die Datei und liefert ihren Pfad. " +
    "action=list zeigt bisherige Exporte, action=get (id) Details, action=delete (id) löscht einen Export, action=status prüft TTS/ffmpeg. " +
    "action=voices (provider?) listet die Stimmen einer Engine plus die Referenzstimmen-Bibliothek.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["synthesize", "list", "get", "delete", "status", "voices", "add_reference_voice"] },
      text: { type: "string", description: "Vorzulesender Text (synthesize)" },
      title: { type: "string", description: "Titel/Dateiname des Exports (synthesize, optional)" },
      format: { type: "string", enum: ["wav", "mp3"], description: "Exportformat (synthesize), Standard aus den Plugin-Einstellungen" },
      provider: { type: "string", enum: PROVIDERS, description: "TTS-Engine (synthesize), Standard = Plugin-Einstellung bzw. Sprache-Tab" },
      voice: { type: "string", description: "Stimme/Voice-ID der Engine (synthesize, optional)" },
      language: { type: "string", description: "Sprachcode z. B. de, en (synthesize, optional)" },
      emotion_style: { type: "string", enum: ["neutral", "calm", "empathetic", "cheerful", "excited"], description: "Emotions-Preset, falls die Engine das unterstützt (synthesize, optional)" },
      emotion_instructions: { type: "string", description: "Freitext zur Sprechweise (OpenAI/Qwen3/Breeze, synthesize, optional)" },
      speed: { type: "number", description: "Geschwindigkeit 0.5-2 (synthesize, optional)" },
      pitch: { type: "number", description: "Tonhöhe 0.5-2 (synthesize, optional)" },
      volume: { type: "number", description: "Lautstärke 0-2 (synthesize, optional)" },
      name: { type: "string", description: "Name der Referenzstimme: Buchstaben, Ziffern, _ und - (add_reference_voice)" },
      audio_base64: { type: "string", description: "WAV-Datei als base64 (add_reference_voice, nur Plugin-Oberfläche)" },
      transcript: { type: "string", description: "Gesprochener Text der Referenzaufnahme, verbessert das Klonen (add_reference_voice, optional)" },
      overwrite: { type: "boolean", description: "Vorhandene Referenzstimme ersetzen (add_reference_voice)" },
      bitrate_kbps: { type: "number", description: "MP3-Bitrate (synthesize, optional)" },
      sample_rate: { type: "number", description: "Ziel-Samplerate in Hz (synthesize, optional)" },
      channels: { type: "number", enum: [1, 2], description: "1 = mono, 2 = stereo (synthesize, optional)" },
      gap_ms: { type: "number", description: "Pause zwischen Textabschnitten in ms (synthesize, optional)" },
      id: { type: "number", description: "Export-ID (get/delete)" },
      lang: { type: "string", enum: ["de", "en"], description: "Sprache der Meldungen (Standard de)" },
      include_audio: { type: "boolean", description: "Audio als base64 mitliefern (nur für die Plugin-Oberfläche)" },
      limit: { type: "number", description: "Max. Anzahl Einträge (list)" },
    },
    required: ["action"],
  },
};

/** User-facing messages; `input.lang` (set by the plugin pages from the app language) picks de or en. */
const MESSAGES = {
  noTts: ["Dieser DucKI-Host stellt Plugins keine TTS-Schnittstelle bereit - bitte DucKI aktualisieren.", "This DucKI host does not offer a TTS interface to plugins - please update DucKI."],
  textRequired: ["text ist erforderlich", "text is required"],
  textTooLong: ["Text zu lang ({n} Zeichen, maximal {max})", "Text too long ({n} characters, maximum {max})"],
  nothingToRead: ["Der Text enthält nichts Vorlesbares", "The text contains nothing to read aloud"],
  tooManyChunks: ["Text ergibt {n} Abschnitte (maximal {max}) - max_chunk_chars erhöhen oder Text kürzen", "Text yields {n} sections (maximum {max}) - raise max_chunk_chars or shorten the text"],
  chunkFailed: ["TTS fehlgeschlagen bei Abschnitt {i}/{n}: {msg}", "TTS failed at section {i}/{n}: {msg}"],
  ffmpegMissing: ["ffmpeg wird für diese Konvertierung benötigt (MP3-Export, gemischte Formate, Tempo/Tonhöhe/Lautstärke), ist aber nicht installiert. Installiere die ffmpeg-Komponente in den Einstellungen oder wähle WAV ohne Effekte.", "ffmpeg is required for this conversion (MP3 export, mixed formats, speed/pitch/volume) but is not installed. Install the ffmpeg component in the settings or choose WAV without effects."],
  idRequired: ["id ist erforderlich", "id is required"],
  exportNotFound: ["Export {id} nicht gefunden", "Export {id} not found"],
  fileMissing: ["Audiodatei {file} fehlt im Export-Ordner", "Audio file {file} is missing from the export folder"],
  noReference: ["Dieser DucKI-Host unterstützt keine Referenzstimmen für Plugins - bitte DucKI aktualisieren.", "This DucKI host does not support reference voices for plugins - please update DucKI."],
  badName: ["Ungültiger Name: nur Buchstaben, Ziffern, _ und - (max. 64 Zeichen)", "Invalid name: letters, digits, _ and - only (max. 64 characters)"],
  audioRequired: ["audio_base64 (WAV) ist erforderlich", "audio_base64 (WAV) is required"],
  referenceTooLarge: ["Referenz-Audio zu groß (max. 30 MB)", "Reference audio too large (max. 30 MB)"],
  unknownAction: ["Unbekannte action '{action}'", "Unknown action '{action}'"],
};

function msg(input, key, vars) {
  const pair = MESSAGES[key];
  let text = String(input && input.lang).toLowerCase().startsWith("en") ? pair[1] : pair[0];
  for (const [k, v] of Object.entries(vars || {})) text = text.split(`{${k}}`).join(String(v));
  return text;
}

function num(value, fallback) {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function str(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The plugin's own copies of the agent's TTS settings (upper-case keys such as
 * CHATTERBOX_SERVER_URL, plus the secret API keys). Only non-empty values are sent, so an empty
 * field means "use the agent's Voice-tab value"; nothing is written to the agent's settings.
 */
function engineSettings(ctx) {
  const out = {};
  for (const source of [ctx.settings || {}, ctx.secrets || {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (/^[A-Z0-9_]+$/.test(key) && value != null && String(value).trim() !== "") out[key] = String(value).trim();
    }
  }
  return out;
}

/** Splits at paragraphs first (each paragraph starts a new chunk), then packs sentences. */
export function splitText(text, maxChars) {
  const max = Math.max(80, maxChars);
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const chunks = [];
  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^.!?…]+(?:[.!?…]+["'»«“”)\]]*|$)/g) ?? [paragraph];
    let current = "";
    for (let sentence of sentences) {
      sentence = sentence.trim();
      if (!sentence) continue;
      while (sentence.length > max) {
        let cut = sentence.lastIndexOf(" ", max);
        if (cut < max * 0.5) cut = max;
        if (current) { chunks.push(current); current = ""; }
        chunks.push(sentence.slice(0, cut).trim());
        sentence = sentence.slice(cut).trim();
      }
      if (current && current.length + 1 + sentence.length > max) {
        chunks.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

function slugify(value) {
  const slug = value
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 48).replace(/-+$/g, "");
  return slug || "sprache";
}

/** Duration from the WAV header, or an estimate from the MP3 bitrate. */
function durationSec(audio, format, bitrateKbps) {
  if (format === "wav" && audio.length > 44 && audio.toString("ascii", 0, 4) === "RIFF") {
    let offset = 12;
    let byteRate = 0;
    while (offset + 8 <= audio.length) {
      const id = audio.toString("ascii", offset, offset + 4);
      const size = audio.readUInt32LE(offset + 4);
      if (id === "fmt ") byteRate = audio.readUInt32LE(offset + 16);
      if (id === "data" && byteRate) return Math.min(size, audio.length - offset - 8) / byteRate;
      offset += 8 + size + (size % 2);
    }
    return null;
  }
  return format === "mp3" ? (audio.length * 8) / (bitrateKbps * 1000) : null;
}

async function ensureSchema(storage) {
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS exports (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, text TEXT NOT NULL, " +
      "provider TEXT, voice TEXT, language TEXT, format TEXT NOT NULL, filename TEXT NOT NULL, size_bytes INTEGER NOT NULL, " +
      "duration_sec REAL, chunks INTEGER NOT NULL, engine TEXT, created_at TEXT NOT NULL)"
  );
}

function publicRow(row) {
  return {
    id: row.id,
    title: row.title,
    text_preview: String(row.text).slice(0, 160),
    provider: row.provider || "standard",
    voice: row.voice || null,
    language: row.language || null,
    format: row.format,
    mime_type: row.format === "mp3" ? "audio/mpeg" : "audio/wav",
    filename: row.filename,
    path: join(EXPORT_DIR, row.filename),
    size_bytes: row.size_bytes,
    duration_sec: row.duration_sec == null ? null : Math.round(row.duration_sec * 10) / 10,
    chunks: row.chunks,
    engine: row.engine,
    created_at: row.created_at,
  };
}

async function getRow(storage, id) {
  const rows = await storage.query("SELECT * FROM exports WHERE id = ?", [id]);
  return rows[0];
}

async function deleteRow(storage, row) {
  await rm(join(EXPORT_DIR, row.filename), { force: true });
  await storage.exec("DELETE FROM exports WHERE id = ?", [row.id]);
}

/** Keeps the newest `limit` exports; limit 0 disables the cap. */
async function pruneHistory(storage, limit) {
  if (!(limit > 0)) return;
  const stale = await storage.query("SELECT * FROM exports ORDER BY id DESC LIMIT -1 OFFSET ?", [limit]);
  for (const row of stale) await deleteRow(storage, row);
}

async function synthesize(input, ctx) {
  const speech = ctx.agent && ctx.agent.speech;
  if (!speech || typeof speech.synthesize !== "function") {
    throw new Error(msg(input, "noTts"));
  }
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new Error(msg(input, "textRequired"));
  if (text.length > MAX_TEXT_CHARS) throw new Error(msg(input, "textTooLong", { n: text.length, max: MAX_TEXT_CHARS }));

  const s = ctx.settings || {};
  const format = (str(input.format) || str(s.default_format) || "mp3") === "wav" ? "wav" : "mp3";
  const providerSetting = str(input.provider) || str(s.default_provider);
  const provider = providerSetting && providerSetting !== "standard" ? providerSetting : undefined;
  const voice = str(input.voice) || (input.provider && input.provider !== s.default_provider ? undefined : str(s.default_voice));
  const language = str(input.language) || str(s.default_language);
  const emotionStyle = str(input.emotion_style) || str(s.emotion_style);
  const emotionInstructions = str(input.emotion_instructions) || str(s.emotion_instructions);
  const tempo = num(input.speed, num(s.speed, 1));
  const pitch = num(input.pitch, num(s.pitch, 1));
  const volume = num(input.volume, num(s.volume, 1));
  const settings = engineSettings(ctx);
  const bitrateKbps = Math.round(num(input.bitrate_kbps, num(s.mp3_bitrate, 192)));
  const sampleRate = Math.round(num(input.sample_rate, num(s.sample_rate, 0))) || undefined;
  const channelsRaw = Math.round(num(input.channels, s.channels === "mono" ? 1 : s.channels === "stereo" ? 2 : 0));
  const channels = channelsRaw === 1 || channelsRaw === 2 ? channelsRaw : undefined;
  const gapMs = Math.max(0, num(input.gap_ms, num(s.gap_ms, 250)));
  const maxChunkChars = num(s.max_chunk_chars, 600);

  const chunks = splitText(text, maxChunkChars);
  if (chunks.length === 0) throw new Error(msg(input, "nothingToRead"));
  if (chunks.length > MAX_CHUNKS) throw new Error(msg(input, "tooManyChunks", { n: chunks.length, max: MAX_CHUNKS }));

  const clips = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      clips.push(await speech.synthesize(chunks[i], { provider, voice, language, emotionStyle, emotionInstructions, settings }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(msg(input, "chunkFailed", { i: i + 1, n: chunks.length, msg: detail }));
    }
  }
  let out;
  try {
    out = await speech.transcode(clips, { format, bitrateKbps, sampleRate, channels, gapMs, tempo, pitch, volume });
  } catch (error) {
    // The host's message is German-only; re-word the common "ffmpeg missing" case.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(/ffmpeg/i.test(detail) && /installiert|installed/i.test(detail) ? msg(input, "ffmpegMissing") : detail);
  }

  const title = str(input.title) || text.replace(/\s+/g, " ").slice(0, 60);
  const createdAt = new Date().toISOString();
  const filename = `${createdAt.slice(0, 19).replace(/[-:T]/g, "")}-${slugify(title)}.${format}`;
  await mkdir(EXPORT_DIR, { recursive: true });
  await writeFile(join(EXPORT_DIR, filename), out.audio);

  const storage = ctx.storage;
  const rows = await storage.query(
    "INSERT INTO exports (title, text, provider, voice, language, format, filename, size_bytes, duration_sec, chunks, engine, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    [title, text, provider ?? null, voice ?? null, language ?? null, format, filename, out.audio.length,
      durationSec(out.audio, format, bitrateKbps), chunks.length, out.engine, createdAt]
  );
  await pruneHistory(storage, Math.round(num(s.history_limit, 50)));

  const result = { created: true, export: publicRow(rows[0]) };
  if (input.include_audio) result.audio_base64 = out.audio.toString("base64");
  ctx.logger?.info?.("TTS export created", { filename, chunks: chunks.length, bytes: out.audio.length, engine: out.engine });
  return result;
}

export async function execute(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  await ensureSchema(storage);

  if (input.action === "synthesize") {
    try {
      return await synthesize(input, ctx);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (input.action === "list") {
    const limit = Math.max(1, Math.min(500, Math.round(num(input.limit, 100))));
    const rows = await storage.query("SELECT * FROM exports ORDER BY id DESC LIMIT ?", [limit]);
    return { count: rows.length, exports: rows.map(publicRow) };
  }

  if (input.action === "get" || input.action === "delete") {
    if (input.id == null) return { error: msg(input, "idRequired") };
    const row = await getRow(storage, Number(input.id));
    if (!row) return { error: msg(input, "exportNotFound", { id: input.id }) };
    if (input.action === "delete") {
      await deleteRow(storage, row);
      return { deleted: true, id: row.id };
    }
    const result = { export: { ...publicRow(row), text: row.text } };
    if (input.include_audio) {
      try {
        result.audio_base64 = (await readFile(join(EXPORT_DIR, row.filename))).toString("base64");
      } catch {
        return { error: msg(input, "fileMissing", { file: row.filename }) };
      }
    }
    return result;
  }

  if (input.action === "voices") {
    const speech = ctx.agent && ctx.agent.speech;
    const s = ctx.settings || {};
    const requested = str(input.provider) || str(s.default_provider);
    const provider = requested && requested !== "standard" ? requested : undefined;
    let voices = [];
    let voicesError;
    if (provider === "openai") {
      voices = OPENAI_VOICES.map((v) => ({ voiceId: v, name: v }));
    } else if (provider && speech && typeof speech.listVoices === "function") {
      try {
        voices = await speech.listVoices(provider, engineSettings(ctx));
      } catch (error) {
        voicesError = error instanceof Error ? error.message : String(error);
      }
    }
    const reference = speech && typeof speech.listReferenceVoices === "function" ? await speech.listReferenceVoices() : [];
    return {
      provider: provider || "standard",
      uses_reference_voices: !provider || REFERENCE_ENGINES.includes(provider),
      voices,
      voices_error: voicesError,
      reference_voices: reference.map((v) => ({ id: v.id, has_transcript: v.hasTranscript, size_bytes: v.sizeBytes })),
    };
  }

  if (input.action === "add_reference_voice") {
    const speech = ctx.agent && ctx.agent.speech;
    if (!speech || typeof speech.saveReferenceVoice !== "function") {
      return { error: msg(input, "noReference") };
    }
    const name = str(input.name);
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
      return { error: msg(input, "badName") };
    }
    if (typeof input.audio_base64 !== "string" || !input.audio_base64) return { error: msg(input, "audioRequired") };
    const wav = Buffer.from(input.audio_base64, "base64");
    if (wav.length > MAX_REFERENCE_BYTES) return { error: msg(input, "referenceTooLarge") };
    try {
      await speech.saveReferenceVoice(name, wav, { transcript: str(input.transcript), overwrite: input.overwrite === true });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    return { saved: true, id: name, size_bytes: wav.length };
  }

  if (input.action === "status") {
    const speech = ctx.agent && ctx.agent.speech;
    let exportBytes = 0;
    const rows = await storage.query("SELECT filename FROM exports");
    for (const row of rows) exportBytes += (await stat(join(EXPORT_DIR, row.filename)).catch(() => ({ size: 0 }))).size;
    return {
      tts_available: Boolean(speech && typeof speech.synthesize === "function"),
      ffmpeg_available: speech ? await speech.ffmpegAvailable() : false,
      export_dir: EXPORT_DIR,
      export_count: rows.length,
      export_bytes: exportBytes,
      providers: PROVIDERS,
      settings: ctx.settings || {},
      reference_voices_supported: Boolean(speech && typeof speech.saveReferenceVoice === "function"),
      engine_overrides: Object.keys(engineSettings(ctx)),
    };
  }

  return { error: msg(input, "unknownAction", { action: input.action }) };
}
