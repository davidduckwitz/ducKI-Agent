/**
 * Social-media video/image analysis (trust: "node"). Projects, items (one per analyzed
 * URL) and questions in the plugin's own SQLite.
 *
 * Item lifecycle: add_item downloads the source (yt-dlp for YouTube/TikTok/Instagram/X/etc.,
 * a direct fetch for plain image/video URLs), runs it through ctx.agent.analyzeVideo() /
 * analyzeImage() (see packages/agent/src/plugins/agent-capabilities.ts), and stores the
 * TRANSCRIPT + SAMPLED FRAMES (base64, frames_json) - not just the answer to one question.
 * That's what makes ask_question work without re-downloading: it replays the stored frames
 * (+ transcript, for video) through analyzeImage() again with a new question. It's also why
 * delete_video_file is safe - the heavy video blob is disposable once analyzed, the frames/
 * transcript it produced are not.
 */

import ytDlp from "yt-dlp-exec";
import ffmpegPath from "ffmpeg-static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, readdirSync, unlinkSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const VIDEOS_DIR = join(PLUGIN_DIR, "data", "videos");
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const definition = {
  name: "social_media",
  description:
    "Video/Bild von einer URL analysieren (YouTube, TikTok, Instagram, X und viele weitere Seiten, oder ein direkter Bild-/Video-Link). " +
    "action=add_project (name) / list_projects / delete_project (id). " +
    "action=add_item (project_id, url, question?) laedt herunter und analysiert (Transkript+Frames bei Video, Vision bei Bild), optional gleich mit einer Frage beantwortet - kann bis zu ~1 Minute dauern. " +
    "action=list_items (project_id?) / get_item (id). " +
    "action=ask_question (item_id, question) beantwortet eine WEITERE Frage zu einem bereits analysierten Item, ohne erneut herunterzuladen. " +
    "action=delete_video_file (id) loescht nur die heruntergeladene Videodatei (Analyse/Transkript/Frames bleiben). " +
    "action=delete_item (id) loescht das Item komplett.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add_project", "list_projects", "delete_project", "add_item", "list_items", "get_item", "ask_question", "delete_video_file", "delete_item"],
      },
      id: { type: "number", description: "Projekt- oder Item-Id (delete_project/get_item/delete_video_file/delete_item)" },
      name: { type: "string", description: "Projektname (add_project)" },
      project_id: { type: "number", description: "Projekt (add_item/list_items)" },
      url: { type: "string", description: "Video- oder Bild-URL (add_item)" },
      question: { type: "string", description: "Frage zum Video/Bild (add_item optional, ask_question erforderlich)" },
      item_id: { type: "number", description: "Item-Id (ask_question)" },
    },
    required: ["action"],
  },
};

async function ensureSchema(storage) {
  await storage.exec("CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL)");
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS items (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, kind TEXT, source_url TEXT NOT NULL, title TEXT, platform TEXT, " +
      "thumbnail_data_url TEXT, transcript TEXT, duration_sec REAL, frame_count INTEGER, frames_json TEXT, video_path TEXT, " +
      "status TEXT NOT NULL DEFAULT 'processing', error TEXT, created_at TEXT NOT NULL)"
  );
  await storage.exec(
    "CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT, " +
      "status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL)"
  );
}

function detectPlatform(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.includes("youtube.com") || host === "youtu.be") return "YouTube";
    if (host.includes("tiktok.com")) return "TikTok";
    if (host.includes("instagram.com")) return "Instagram";
    if (host.includes("x.com") || host.includes("twitter.com")) return "X";
    return host;
  } catch {
    return "Web";
  }
}

function extFromMime(mimeType) {
  const map = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
  return map[mimeType?.split(";")[0]?.trim()];
}

/** Detects whether a URL is a yt-dlp-supported page (YouTube/TikTok/Instagram/X/...) via a
 *  metadata-only probe (no download), or falls back to a direct fetch + content-type check
 *  for a plain image/video link. Never downloads more than once. */
async function probeSource(url) {
  try {
    const info = await ytDlp(url, { dumpSingleJson: true, noWarnings: true, noPlaylist: true, skipDownload: true });
    if (info && typeof info === "object" && info.id) {
      return { kind: "video", viaYtDlp: true, title: typeof info.title === "string" ? info.title : undefined };
    }
  } catch {
    // Not a yt-dlp-supported page - fall through to a direct fetch.
  }

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`URL nicht erreichbar (HTTP ${res.status})`);
  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
  const buffer = Buffer.from(await res.arrayBuffer());
  if (contentType.startsWith("video/")) {
    if (buffer.length > MAX_VIDEO_BYTES) throw new Error("Video zu groß (Limit 80MB)");
    return { kind: "video", viaYtDlp: false, buffer, mimeType: contentType };
  }
  if (contentType.startsWith("image/")) {
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Bild zu groß (Limit 20MB)");
    return { kind: "image", buffer, mimeType: contentType };
  }
  throw new Error(`Nicht unterstützter Inhaltstyp: ${contentType || "unbekannt"}`);
}

async function downloadViaYtDlp(url, itemId) {
  mkdirSync(VIDEOS_DIR, { recursive: true });
  const outputTemplate = join(VIDEOS_DIR, `${itemId}.%(ext)s`);
  await ytDlp(url, {
    output: outputTemplate,
    format: "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best",
    mergeOutputFormat: "mp4",
    noPlaylist: true,
    maxFilesize: "80M",
    ffmpegLocation: ffmpegPath || undefined,
    noWarnings: true,
  });
  const match = readdirSync(VIDEOS_DIR).find((f) => f.startsWith(`${itemId}.`));
  if (!match) throw new Error("yt-dlp-Download fehlgeschlagen (keine Ausgabedatei gefunden)");
  return match;
}

function saveVideoBuffer(itemId, buffer, mimeType) {
  mkdirSync(VIDEOS_DIR, { recursive: true });
  const ext = extFromMime(mimeType) || "mp4";
  const fileName = `${itemId}.${ext}`;
  writeFileSync(join(VIDEOS_DIR, fileName), buffer);
  return fileName;
}

function removeVideoFile(videoPath) {
  if (!videoPath) return;
  const abs = join(VIDEOS_DIR, videoPath);
  if (existsSync(abs)) unlinkSync(abs);
}

const ITEM_COLUMNS =
  "id, project_id, kind, source_url, title, platform, thumbnail_data_url, transcript, duration_sec, frame_count, video_path, status, error, created_at";

async function addItem(input, storage, agent) {
  const projectId = Number(input.project_id);
  const url = String(input.url || "").trim();
  if (!Number.isFinite(projectId)) return { error: "project_id ist erforderlich" };
  if (!url) return { error: "url ist erforderlich" };
  const question = input.question ? String(input.question).trim() : undefined;

  const now = new Date().toISOString();
  const [item] = await storage.query(
    "INSERT INTO items (project_id, source_url, platform, status, created_at) VALUES (?, ?, ?, 'processing', ?) RETURNING *",
    [projectId, url, detectPlatform(url), now]
  );

  try {
    const probe = await probeSource(url);
    let result;

    if (probe.kind === "video") {
      const videoPath = probe.viaYtDlp ? await downloadViaYtDlp(url, item.id) : saveVideoBuffer(item.id, probe.buffer, probe.mimeType);
      const videoBuffer = readFileSync(join(VIDEOS_DIR, videoPath));
      const analysis = await agent.analyzeVideo(videoBuffer, question);
      result = {
        kind: "video",
        title: probe.title,
        transcript: analysis.transcript,
        duration_sec: analysis.durationSec,
        frame_count: analysis.frameCount,
        frames: analysis.frames,
        thumbnail_data_url: analysis.frames[0] ? `data:image/jpeg;base64,${analysis.frames[0].base64}` : null,
        answer: analysis.analysis,
        video_path: videoPath,
      };
    } else {
      const base64 = probe.buffer.toString("base64");
      const answer = question ? await agent.analyzeImage([{ base64, mimeType: probe.mimeType }], question) : undefined;
      result = {
        kind: "image",
        frames: [{ timestampSec: 0, base64 }],
        thumbnail_data_url: `data:${probe.mimeType};base64,${base64}`,
        answer,
      };
    }

    await storage.exec(
      "UPDATE items SET kind=?, title=?, thumbnail_data_url=?, transcript=?, duration_sec=?, frame_count=?, frames_json=?, video_path=?, status='ready' WHERE id=?",
      [
        result.kind,
        result.title ?? null,
        result.thumbnail_data_url ?? null,
        result.transcript ?? null,
        result.duration_sec ?? null,
        result.frame_count ?? result.frames.length,
        JSON.stringify(result.frames),
        result.video_path ?? null,
        item.id,
      ]
    );

    let questionRow;
    if (question) {
      const [row] = await storage.query(
        "INSERT INTO questions (item_id, question, answer, status, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
        [item.id, question, result.answer ?? null, result.answer ? "answered" : "error", new Date().toISOString()]
      );
      questionRow = row;
    }

    const [updated] = await storage.query(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`, [item.id]);
    return { item: { ...updated, has_video_file: !!updated.video_path }, question: questionRow };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await storage.exec("UPDATE items SET status='error', error=? WHERE id=?", [message, item.id]);
    return { error: message, item_id: item.id };
  }
}

async function askQuestion(input, storage, agent) {
  const itemId = Number(input.item_id);
  const question = String(input.question || "").trim();
  if (!Number.isFinite(itemId)) return { error: "item_id ist erforderlich" };
  if (!question) return { error: "question ist erforderlich" };

  const [item] = await storage.query("SELECT * FROM items WHERE id = ?", [itemId]);
  if (!item) return { error: "Item nicht gefunden" };
  if (item.status !== "ready") return { error: `Item ist nicht bereit (status=${item.status})` };

  const frames = JSON.parse(item.frames_json || "[]");
  if (frames.length === 0) return { error: "Keine gespeicherten Frames für dieses Item - erneut hinzufügen." };

  const images = frames.map((f) => ({ base64: f.base64, mimeType: "image/jpeg" }));
  const prompt = item.transcript ? `Transcript: ${item.transcript}\n\nFrage: ${question}` : question;

  let answer, status, error;
  try {
    answer = await agent.analyzeImage(images, prompt);
    status = "answered";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    status = "error";
  }

  const [row] = await storage.query(
    "INSERT INTO questions (item_id, question, answer, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
    [itemId, question, answer ?? null, status, error ?? null, new Date().toISOString()]
  );
  return { question: row };
}

export async function execute(input, ctx) {
  const storage = ctx.storage;
  if (!storage) return { error: "plugin storage not enabled" };
  await ensureSchema(storage);

  if (input.action === "add_project") {
    if (!input.name) return { error: "name ist erforderlich" };
    const [project] = await storage.query("INSERT INTO projects (name, created_at) VALUES (?, ?) RETURNING *", [input.name, new Date().toISOString()]);
    return { added: true, project };
  }

  if (input.action === "list_projects") {
    const projects = await storage.query("SELECT * FROM projects ORDER BY name ASC");
    return { count: projects.length, projects };
  }

  if (input.action === "delete_project") {
    const id = Number(input.id);
    if (!Number.isFinite(id)) return { error: "id ist erforderlich" };
    const items = await storage.query("SELECT * FROM items WHERE project_id = ?", [id]);
    for (const item of items) {
      removeVideoFile(item.video_path);
      await storage.exec("DELETE FROM questions WHERE item_id = ?", [item.id]);
    }
    await storage.exec("DELETE FROM items WHERE project_id = ?", [id]);
    await storage.exec("DELETE FROM projects WHERE id = ?", [id]);
    return { ok: true };
  }

  // Everything past here needs LLM-backed capabilities (download+analyze/ask) - only
  // populated for trust:"node" plugins (this one), but fail clearly instead of throwing if
  // it's ever missing (e.g. a future context change).
  if (["add_item", "ask_question"].includes(input.action) && !ctx.agent) {
    return { error: "Agent-Capabilities (analyzeVideo/analyzeImage) sind in diesem Kontext nicht verfügbar." };
  }

  if (input.action === "add_item") return addItem(input, storage, ctx.agent);
  if (input.action === "ask_question") return askQuestion(input, storage, ctx.agent);

  if (input.action === "list_items") {
    const projectId = input.project_id != null ? Number(input.project_id) : undefined;
    let sql = `SELECT ${ITEM_COLUMNS} FROM items`;
    const args = [];
    if (projectId != null) {
      sql += " WHERE project_id = ?";
      args.push(projectId);
    }
    sql += " ORDER BY created_at DESC";
    const rows = await storage.query(sql, args);
    return { count: rows.length, items: rows.map((r) => ({ ...r, has_video_file: !!r.video_path })) };
  }

  if (input.action === "get_item") {
    const id = Number(input.id);
    if (!Number.isFinite(id)) return { error: "id ist erforderlich" };
    const [item] = await storage.query(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`, [id]);
    if (!item) return { error: "Item nicht gefunden" };
    const questions = await storage.query("SELECT * FROM questions WHERE item_id = ? ORDER BY created_at ASC", [id]);
    return { item: { ...item, has_video_file: !!item.video_path }, questions };
  }

  if (input.action === "delete_video_file") {
    const id = Number(input.id);
    if (!Number.isFinite(id)) return { error: "id ist erforderlich" };
    const [item] = await storage.query("SELECT * FROM items WHERE id = ?", [id]);
    if (!item) return { error: "Item nicht gefunden" };
    removeVideoFile(item.video_path);
    await storage.exec("UPDATE items SET video_path = NULL WHERE id = ?", [id]);
    return { ok: true };
  }

  if (input.action === "delete_item") {
    const id = Number(input.id);
    if (!Number.isFinite(id)) return { error: "id ist erforderlich" };
    const [item] = await storage.query("SELECT * FROM items WHERE id = ?", [id]);
    if (item) removeVideoFile(item.video_path);
    await storage.exec("DELETE FROM questions WHERE item_id = ?", [id]);
    await storage.exec("DELETE FROM items WHERE id = ?", [id]);
    return { ok: true };
  }

  return { error: `Unbekannte action: ${input.action}` };
}
