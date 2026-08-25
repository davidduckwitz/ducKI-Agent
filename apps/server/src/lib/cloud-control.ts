/**
 * "Cloud Control" -- Fernsteuerung des Agenten ueber die Laravel-Command-Queue (siehe
 * ducki-cloud-v1 RemoteControlService). Zwei Haelften:
 *  - gatherStateSnapshot(): baut den Zustands-Spiegel (Cronjobs/Skills/Plugins/erlaubte
 *    Settings), den der Heartbeat mitschickt, damit das Dashboard etwas zum Anzeigen hat.
 *  - dispatchCommand(): fuehrt einen einzelnen, vom Dashboard gequeueten Befehl lokal aus,
 *    indem dieselben internen Funktionen aufgerufen werden, die auch die lokalen HTTP-Routen
 *    (routes/cronjobs.ts, routes/plugins.ts, routes/skills.ts) benutzen -- keine Business-Logik
 *    wird hier dupliziert.
 *
 * Bewusst standardmaessig AUS (CLOUD_CONTROL_ENABLED, Default false): erst wenn aktiv, sendet
 * der Heartbeat ueberhaupt einen state_snapshot und nimmt pendingCommands entgegen.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, relative } from "node:path";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import type { Agent, LoadedPluginInfo } from "@ducki/agent";
import { setPluginEnabled, isKnownVideoPlatform, fetchVideoFromUrl, analyzeVideo } from "@ducki/agent";
import { SHARED_WORKSPACE_ROOT, browserTool } from "@ducki/tools";
import { installSkillFromSource } from "./skill-install.js";
import { transcribeAudioBuffer } from "./audio-transcription.js";
import { listActiveProviderModels } from "./provider-settings.js";

export const SETTING_CLOUD_CONTROL_ENABLED = "CLOUD_CONTROL_ENABLED";

/**
 * Bewusst kuratiert -- MUSS mit RemoteControlService::ALLOWED_SETTING_KEYS im Laravel-Repo
 * uebereinstimmen. Niemals Provider-API-Keys oder andere Secrets hier aufnehmen.
 */
export const ALLOWED_SETTING_KEYS = [
  "DEFAULT_PROVIDER",
  "AGENT_MAX_ITERATIONS",
  "AGENT_ENABLE_REFLECTION",
  "AGENT_ENABLE_VERIFY",
  "AGENT_AUTO_MEMORY",
  "AGENT_AUTO_SKILL_SELECTION",
  "PLAN_MODE_ENABLED",
  "CODING_ENABLED",
];

export async function isCloudControlEnabled(db: DatabaseService): Promise<boolean> {
  return (await db.getSetting(SETTING_CLOUD_CONTROL_ENABLED)) === "true";
}

export async function setCloudControlEnabled(db: DatabaseService, enabled: boolean): Promise<void> {
  await db.setSetting(SETTING_CLOUD_CONTROL_ENABLED, enabled ? "true" : "false");
}

function resolveSkillsRoot(): string {
  const configured = process.env["SKILLS_PATH"]?.trim();
  if (configured) return join(configured);
  const monorepoCandidate = join(process.cwd(), "../../skills");
  if (existsSync(monorepoCandidate)) return monorepoCandidate;
  return join(process.cwd(), "skills");
}

function listSkillSlugs(): string[] {
  const root = resolveSkillsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")))
    .map((entry) => entry.name);
}

/** Fallback-Endung, falls weder ein Dateiname noch eine bekannte Mime-Type vorliegt. */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
};

/** Muss dem isImageAttachment-Check in agent.ts entsprechen (mimeType-Praefix). */
function isImageMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("image/");
}

/** Muss dem isVideoAttachment-Check in agent.ts entsprechen (mimeType-Praefix). */
function isVideoMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("video/");
}

/** Unterordner unter dem Shared-Workspace fuer kurzlebige Chat-Datei-Uploads (Voice-Chat-Anhaenge). */
const VOICE_UPLOAD_DIR = "voice-uploads";

/**
 * Schreibt einen per Cloud Control eingereichten Anhang (Bild, PDF, Text/Code, ...) als
 * temporaere Datei ins Shared-Workspace (Agent.run()-Attachments werden relativ zum Workspace
 * aufgeloest, siehe agent.ts buildAttachmentImageContent/buildAttachmentTextContent). Behaelt
 * nach Moeglichkeit die ORIGINALE Dateiendung bei -- agent.ts erkennt Text-/Code-Anhaenge ueber
 * eine Endungs-Regel (isTextAttachment), und Browser liefern fuer viele Code-/Textdateien keine
 * (oder falsche) Mime-Types ueber <input type="file">.
 *
 * Der Aufrufer MUSS die Datei danach mit removeTempWorkspaceFile wieder loeschen -- diese
 * Uploads sind reine Analyse-Eingaben, keine dauerhaften Nutzerdaten.
 */
async function writeTempWorkspaceFile(base64: string, mimeType: string, originalName?: string): Promise<string> {
  const nameExt = originalName ? extname(originalName).replace(/^\./, "").toLowerCase() : "";
  const ext = nameExt || EXTENSION_BY_MIME[mimeType.toLowerCase()] || "bin";
  const relativePath = join(VOICE_UPLOAD_DIR, `${randomUUID()}.${ext}`);
  const absolutePath = join(SHARED_WORKSPACE_ROOT, relativePath);
  await mkdir(join(SHARED_WORKSPACE_ROOT, VOICE_UPLOAD_DIR), { recursive: true });
  await writeFile(absolutePath, Buffer.from(base64, "base64"));
  return relativePath;
}

async function removeTempWorkspaceFile(relativePath: string): Promise<void> {
  await unlink(join(SHARED_WORKSPACE_ROOT, relativePath)).catch(() => {});
}

const MEDIA_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg",
  "mp4", "webm", "mov",
]);
const MEDIA_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
};
/** Top-level-Ordner, die beim Scan nach neuen Medien uebersprungen werden (Scratch-/Upload-Dirs). */
const MEDIA_SCAN_EXCLUDED_DIRS = new Set(["bitcoin-puzzle-attempts", VOICE_UPLOAD_DIR]);
const MEDIA_SCAN_MAX_DEPTH = 3;
const MEDIA_SCAN_MAX_FILES_VISITED = 500;
const MEDIA_SCAN_MAX_RESULTS = 3;
const MEDIA_SCAN_MAX_FILE_BYTES = 6 * 1024 * 1024;

export interface OutboundMediaAttachment {
  name: string;
  mimeType: string;
  base64: string;
}

/**
 * Best-effort-Suche nach Bild-/Video-Dateien, die der Agent WAEHREND dieses Laufs neu im
 * Shared-Workspace angelegt hat (z.B. ein von einem Tool erzeugter Chart/Screenshot) --
 * es gibt (noch) keinen expliziten "haenge dieses Bild an deine Antwort an"-Mechanismus im
 * Agenten, daher dieser Heuristik-Ansatz ueber Datei-mtime. Bewusst eng begrenzt (Tiefe,
 * Dateizahl, Groesse), damit ein einzelner Chat-Turn nicht den gesamten Workspace durchsucht
 * oder eine grosse Datei komplett einliest.
 */
async function findNewMediaFiles(sinceMs: number): Promise<OutboundMediaAttachment[]> {
  const results: Array<{ path: string; mtimeMs: number }> = [];
  let visited = 0;

  function walk(dir: string, depth: number): void {
    if (depth > MEDIA_SCAN_MAX_DEPTH || visited >= MEDIA_SCAN_MAX_FILES_VISITED) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= MEDIA_SCAN_MAX_FILES_VISITED) return;
      if (depth === 0 && entry.isDirectory() && MEDIA_SCAN_EXCLUDED_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }
      visited++;
      const ext = extname(entry.name).replace(/^\./, "").toLowerCase();
      if (!MEDIA_EXTENSIONS.has(ext)) continue;
      try {
        const stat = statSync(fullPath);
        if (stat.mtimeMs >= sinceMs && stat.size > 0 && stat.size <= MEDIA_SCAN_MAX_FILE_BYTES) {
          results.push({ path: fullPath, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // Datei zwischen readdir und stat verschwunden - ignorieren.
      }
    }
  }

  walk(SHARED_WORKSPACE_ROOT, 0);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const attachments: OutboundMediaAttachment[] = [];
  for (const { path } of results.slice(0, MEDIA_SCAN_MAX_RESULTS)) {
    try {
      const buffer = await readFile(path);
      const ext = extname(path).replace(/^\./, "").toLowerCase();
      attachments.push({
        name: relative(SHARED_WORKSPACE_ROOT, path).replace(/\\/g, "/"),
        mimeType: MEDIA_MIME_BY_EXTENSION[ext] ?? "application/octet-stream",
        base64: buffer.toString("base64"),
      });
    } catch {
      // Konnte nicht gelesen werden - ueberspringen statt den ganzen Turn scheitern zu lassen.
    }
  }
  return attachments;
}

export interface CloudControlDeps {
  db: DatabaseService;
  logger: Logger;
  getPlugins: () => LoadedPluginInfo[];
  requestPluginReload: () => void;
  createAgent: (override?: { model?: string }) => Promise<Agent>;
  runMainBot?: (message: string) => Promise<{ response: string; conversationId: number; stalled: boolean }>;
  listBots?: () => Promise<Array<Record<string, unknown>>>;
}

/**
 * Runs inside the target page (via the browser tool's "evaluate" action, see "url.preview"
 * below) to pull Open Graph/meta preview data in one round trip: og:title/description/image
 * with sensible fallbacks (<title>, name="description"), plus the page's actual favicon href.
 * A page with no real favicon <link> can still resolve to a useless "data:," placeholder
 * (observed on example.com) - rejected here too, not just a missing href, before falling back
 * to the conventional /favicon.ico path.
 */
const EXTRACT_URL_PREVIEW_META_SCRIPT = `(() => {
  const meta = (name) => {
    const el = document.querySelector('meta[property="' + name + '"]') || document.querySelector('meta[name="' + name + '"]');
    const content = el ? el.getAttribute('content') : null;
    return content && content.trim() ? content.trim() : null;
  };
  const iconLink = document.querySelector('link[rel~="icon"]') || document.querySelector('link[rel="shortcut icon"]');
  const iconHref = iconLink && iconLink.href;
  let ogImage = meta('og:image') || meta('twitter:image');
  if (ogImage) {
    try { ogImage = new URL(ogImage, location.href).href; } catch {}
  }
  return {
    title: meta('og:title') || document.title || '',
    description: meta('og:description') || meta('description'),
    ogImage: ogImage || null,
    faviconUrl: (iconHref && !iconHref.startsWith('data:')) ? iconHref : new URL('/favicon.ico', location.href).href,
  };
})()`;

/** Provider-Namen -> Setting-Key des dort konfigurierten Modells (siehe loadProviderFromSettings in index.ts). */
const MODEL_SETTING_BY_PROVIDER: Record<string, string> = {
  lmstudio: "LM_STUDIO_MODEL",
  openrouter: "OPENROUTER_MODEL",
  openai: "OPENAI_MODEL",
  claude: "CLAUDE_MODEL",
};

/**
 * Liest Provider + Modell rein zur ANZEIGE (Voice-Chat-Fusszeile) aus den Settings -- KEINE
 * Provider-Instanz, kein API-Key-Handling, nur die beiden Strings. Muss den Provider-Namen
 * genauso auflösen wie loadProviderFromSettings() in index.ts, sonst zeigt die Fusszeile den
 * falschen Provider an.
 */
async function describeActiveProvider(db: DatabaseService, modelOverride?: string): Promise<{ providerName: string; model: string }> {
  const providerName = ((await db.getSetting("DEFAULT_PROVIDER")) || "lmstudio").trim().toLowerCase();
  const modelSettingKey = MODEL_SETTING_BY_PROVIDER[providerName];
  const model = modelOverride?.trim() || (modelSettingKey ? await db.getSetting(modelSettingKey) : undefined) || "unbekannt";
  return { providerName, model };
}

/**
 * Setzt eine bestehende Voice-Chat-Konversation fort (payload.conversationId), oder startet
 * eine neue, wenn keine/keine gueltige id mitgeschickt wurde -- damit ein Voice-Chat sich wie
 * ein zusammenhaengendes Gespraech anfuehlt statt bei jeder Nachricht das Gedaechtnis zu
 * verlieren. Der Client (voice.blade.php) merkt sich die zuletzt zurueckgegebene
 * conversationId und schickt sie beim naechsten Senden wieder mit; "Neuer Chat" im UI
 * verwirft diesen gespeicherten Wert.
 */
async function resolveVoiceConversation(
  deps: CloudControlDeps,
  agent: Agent,
  payload: Record<string, unknown>,
  fallbackName: string
): Promise<number> {
  const requestedId = Number(payload["conversationId"]);
  if (Number.isFinite(requestedId) && requestedId > 0) {
    const existing = await deps.db.getConversation(requestedId);
    if (existing) {
      await agent.loadConversation(requestedId);
      return requestedId;
    }
  }
  const conversationId = await agent.startConversation({ name: fallbackName });
  await agent.loadConversation(conversationId);
  return conversationId;
}

export interface StateSnapshot {
  cronjobs: Array<{ id: number; name: string; schedule: string; enabled: boolean; targetType: string }>;
  skills: Array<{ slug: string; name: string }>;
  plugins: Array<{ name: string; version: string; enabled: boolean }>;
  settings: Record<string, string>;
}

export async function gatherStateSnapshot(deps: CloudControlDeps): Promise<StateSnapshot> {
  const jobs = await deps.db.listCronJobs();
  const cronjobs = jobs.map((job) => ({
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    enabled: !!job.enabled,
    targetType: job.targetType,
  }));

  const skills = listSkillSlugs().map((slug) => ({ slug, name: slug }));

  const plugins = deps.getPlugins().map((plugin) => ({
    name: plugin.name,
    version: plugin.version,
    enabled: plugin.enabled,
  }));

  const settings: Record<string, string> = {};
  for (const key of ALLOWED_SETTING_KEYS) {
    const value = await deps.db.getSetting(key);
    if (value !== undefined) settings[key] = value;
  }

  return { cronjobs, skills, plugins, settings };
}

export interface PendingCommand {
  id: number;
  type: string;
  payload: Record<string, unknown> | null;
}

export interface CommandOutcome {
  status: "done" | "failed";
  result?: Record<string, unknown>;
}

/** Fuehrt einen einzelnen Befehl lokal aus. Wirft nie -- Fehler werden als 'failed' zurueckgegeben. */
export async function dispatchCommand(deps: CloudControlDeps, command: PendingCommand): Promise<CommandOutcome> {
  const payload = command.payload ?? {};
  try {
    switch (command.type) {
      case "voice.models": {
        return { status: "done", result: await listActiveProviderModels(deps.db) };
      }

      case "voice.bots": {
        if (!deps.listBots) throw new Error("voice.bots: BotService ist nicht verfuegbar");
        return { status: "done", result: { bots: await deps.listBots() } };
      }

      case "cronjob.delete": {
        const id = Number(payload["id"]);
        if (!Number.isFinite(id)) throw new Error("cronjob.delete: 'id' fehlt oder ungueltig");
        await deps.db.deleteCronJob(id);
        return { status: "done", result: { id } };
      }

      case "cronjob.update": {
        const id = Number(payload["id"]);
        if (!Number.isFinite(id)) throw new Error("cronjob.update: 'id' fehlt oder ungueltig");
        const patch: { enabled?: number } = {};
        if (typeof payload["enabled"] === "boolean") patch.enabled = payload["enabled"] ? 1 : 0;
        const updated = await deps.db.updateCronJob(id, patch);
        if (!updated) throw new Error(`cronjob.update: Cronjob ${id} nicht gefunden`);
        return { status: "done", result: { id } };
      }

      case "skill.install": {
        const source = String(payload["source"] ?? "").trim();
        if (!source) throw new Error("skill.install: 'source' fehlt");
        const result = await installSkillFromSource({ source, skillsRoot: resolveSkillsRoot() });
        return { status: "done", result: { slug: result.slug } };
      }

      case "skill.delete": {
        const slug = String(payload["slug"] ?? "").trim();
        if (!slug) throw new Error("skill.delete: 'slug' fehlt");
        const skillDir = join(resolveSkillsRoot(), slug);
        if (!existsSync(skillDir)) throw new Error(`skill.delete: '${slug}' nicht gefunden`);
        rmSync(skillDir, { recursive: true, force: true });
        return { status: "done", result: { slug } };
      }

      case "plugin.enable":
      case "plugin.disable": {
        const name = String(payload["name"] ?? "").trim();
        if (!name) throw new Error(`${command.type}: 'name' fehlt`);
        setPluginEnabled(name, command.type === "plugin.enable");
        deps.requestPluginReload();
        return { status: "done", result: { name } };
      }

      case "setting.update": {
        const key = String(payload["key"] ?? "");
        if (!ALLOWED_SETTING_KEYS.includes(key)) throw new Error(`setting.update: '${key}' ist nicht freigegeben`);
        const value = String(payload["value"] ?? "");
        await deps.db.setSetting(key, value);
        return { status: "done", result: { key, value } };
      }

      case "chat.send": {
        const message = String(payload["message"] ?? "").trim();
        if (!message) throw new Error("chat.send: 'message' fehlt");
        const requestedModel = String(payload["model"] ?? "").trim();
        const agent = await deps.createAgent(requestedModel ? { model: requestedModel } : undefined);
        const conversationId = await resolveVoiceConversation(deps, agent, payload, `Cloud Control: ${message.slice(0, 40)}`);

        const attachmentBase64 = typeof payload["attachment"] === "string" ? payload["attachment"].trim() : "";
        const artifactId = payload["artifactId"] != null ? Number(payload["artifactId"]) : undefined;
        const runStartedAt = Date.now();

        // A video the Voice-App auto-detected and previewed BEFORE this message was sent (see
        // "video.preview") - the video itself was deleted right after analysis, but its stored
        // frames/transcript are still on the artifact row. Materialize the frames as temp image
        // attachments (same buildAttachmentImageContent path any image attachment already goes
        // through) and prepend the transcript, instead of re-downloading anything - this is
        // exactly where the LLM actually gets involved with the video, per design.
        if (Number.isFinite(artifactId) && artifactId! > 0) {
          const artifact = await deps.db.getArtifact(artifactId!);
          if (!artifact) throw new Error(`chat.send: Artefakt ${artifactId} nicht gefunden`);
          const frames = artifact.framesJson ? (JSON.parse(artifact.framesJson) as { timestampSec: number; base64: string }[]) : [];
          if (frames.length === 0) throw new Error(`chat.send: Artefakt ${artifactId} hat keine gespeicherten Frames`);

          const framePaths: string[] = [];
          try {
            for (const frame of frames) {
              framePaths.push(await writeTempWorkspaceFile(frame.base64, "image/jpeg"));
            }
            const transcriptLine = artifact.transcript ? `[Video-Transkript: ${artifact.transcript}]\n\n` : "";
            const runResult = await agent.run(`${transcriptLine}${message}`, {
              attachments: framePaths.map((path, i) => ({ name: `frame-${i}.jpg`, path, mimeType: "image/jpeg" })),
              visionOnly: true,
            });
            const mediaAttachments = await findNewMediaFiles(runStartedAt);
            const { providerName, model } = await describeActiveProvider(deps.db, requestedModel);
            const contextMessageCount = await deps.db.getMessageCount(conversationId);
            return { status: "done", result: { reply: runResult.response, conversationId, mediaAttachments, providerName, model, contextMessageCount } };
          } finally {
            for (const path of framePaths) await removeTempWorkspaceFile(path);
          }
        }

        if (!attachmentBase64) {
          const runResult = await agent.run(message);
          const mediaAttachments = await findNewMediaFiles(runStartedAt);
          const { providerName, model } = await describeActiveProvider(deps.db, requestedModel);
          const contextMessageCount = await deps.db.getMessageCount(conversationId);
          return { status: "done", result: { reply: runResult.response, conversationId, mediaAttachments, providerName, model, contextMessageCount } };
        }

        const attachmentMimeType = String(payload["attachmentMimeType"] ?? "application/octet-stream");
        const attachmentName = typeof payload["attachmentName"] === "string" ? payload["attachmentName"] : undefined;
        const attachmentPath = await writeTempWorkspaceFile(attachmentBase64, attachmentMimeType, attachmentName);
        try {
          // visionOnly nur bei Bildern: fuer PDF/Text-Anhaenge uebernimmt der normale Lauf
          // (buildAttachmentTextContent) die Extraktion bereits mit -- visionOnly wuerde diesen
          // Pfad umgehen und die Datei ignorieren, wenn es kein Bild ist.
          const runResult = await agent.run(message, {
            attachments: [{ name: attachmentName ?? "voice-chat-upload", path: attachmentPath, mimeType: attachmentMimeType }],
            visionOnly: isImageMimeType(attachmentMimeType) || isVideoMimeType(attachmentMimeType),
          });
          const mediaAttachments = await findNewMediaFiles(runStartedAt);
          const { providerName, model } = await describeActiveProvider(deps.db, requestedModel);
          const contextMessageCount = await deps.db.getMessageCount(conversationId);
          return { status: "done", result: { reply: runResult.response, conversationId, mediaAttachments, providerName, model, contextMessageCount } };
        } finally {
          await removeTempWorkspaceFile(attachmentPath);
        }
      }

      case "bot.chat.send": {
        const message = String(payload["message"] ?? "").trim();
        if (!message) throw new Error("bot.chat.send: 'message' fehlt");
        if (!deps.runMainBot) throw new Error("bot.chat.send: BotService ist nicht verfuegbar");
        const runResult = await deps.runMainBot(message);
        const { providerName, model } = await describeActiveProvider(deps.db);
        const contextMessageCount = await deps.db.getMessageCount(runResult.conversationId);
        return {
          status: "done",
          result: {
            reply: runResult.response,
            botConversationId: runResult.conversationId,
            providerName,
            model,
            contextMessageCount,
            stalled: runResult.stalled,
          },
        };
      }

      case "voice.transcribe": {
        const base64Audio = String(payload["audio"] ?? "").trim();
        if (!base64Audio) throw new Error("voice.transcribe: 'audio' fehlt");
        const audioBuffer = Buffer.from(base64Audio, "base64");
        if (audioBuffer.length === 0) throw new Error("voice.transcribe: Audiodaten sind leer");

        // Dieselbe Pipeline wie /api/chat/transcribe und der Discord-Gateway-Sprachkanal
        // (siehe audio-transcription.ts) -- danach wie chat.send behandeln, damit eine
        // Sprachnachricht in einem Roundtrip transkribiert UND beantwortet wird.
        const transcript = await transcribeAudioBuffer(deps.db, audioBuffer);
        if (!transcript) throw new Error("voice.transcribe: Keine Sprache erkannt");

        if (payload["mode"] === "team") {
          if (!deps.runMainBot) throw new Error("voice.transcribe: BotService ist nicht verfuegbar");
          const runResult = await deps.runMainBot(transcript);
          const { providerName, model } = await describeActiveProvider(deps.db);
          const contextMessageCount = await deps.db.getMessageCount(runResult.conversationId);
          return {
            status: "done",
            result: {
              transcript,
              reply: runResult.response,
              botConversationId: runResult.conversationId,
              providerName,
              model,
              contextMessageCount,
              stalled: runResult.stalled,
            },
          };
        }

        const requestedModel = String(payload["model"] ?? "").trim();
        const agent = await deps.createAgent(requestedModel ? { model: requestedModel } : undefined);
        const conversationId = await resolveVoiceConversation(deps, agent, payload, `Voice: ${transcript.slice(0, 40)}`);
        const runStartedAt = Date.now();
        const runResult = await agent.run(transcript);
        const mediaAttachments = await findNewMediaFiles(runStartedAt);
        const { providerName, model } = await describeActiveProvider(deps.db, requestedModel);
        const contextMessageCount = await deps.db.getMessageCount(conversationId);
        return { status: "done", result: { transcript, reply: runResult.response, conversationId, mediaAttachments, providerName, model, contextMessageCount } };
      }

      case "chat.compact": {
        const conversationId = Number(payload["conversationId"]);
        if (!Number.isFinite(conversationId) || conversationId <= 0) {
          throw new Error("chat.compact: 'conversationId' fehlt oder ungueltig");
        }
        const existing = await deps.db.getConversation(conversationId);
        if (!existing) throw new Error(`chat.compact: Konversation ${conversationId} nicht gefunden`);

        const messageCountBefore = await deps.db.getMessageCount(conversationId);
        if (messageCountBefore < 6) {
          const { providerName, model } = await describeActiveProvider(deps.db);
          return {
            status: "done",
            result: { summary: null, skipped: true, conversationId, providerName, model, contextMessageCount: messageCountBefore },
          };
        }

        const agent = await deps.createAgent();
        await agent.loadConversation(conversationId);
        const summaryResult = await agent.run(
          "Fasse dieses Gespraech bisher in 3-5 knappen Saetzen zusammen. Konzentriere dich auf Fakten, " +
            "Entscheidungen und offene Punkte, die fuer die Fortsetzung des Gespraechs wichtig sind. " +
            "Antworte NUR mit der Zusammenfassung, ohne Einleitung.",
          { agentMode: "chatbot" }
        );

        // Verlauf inkl. der eben gestellten Zusammenfassungs-Frage verwerfen und stattdessen
        // NUR die Zusammenfassung als Systemnotiz behalten -- das ist der eigentliche Zweck von
        // "komprimieren": weniger Kontext-Tokens fuer folgende Nachrichten, bei erhaltenem Kern.
        await deps.db.deleteMessages(conversationId);
        await deps.db.addMessage({
          conversationId,
          role: "system",
          content: `Bisheriger Gespraechsverlauf (komprimiert): ${summaryResult.response}`,
        });

        const { providerName, model } = await describeActiveProvider(deps.db);
        const contextMessageCount = await deps.db.getMessageCount(conversationId);
        return {
          status: "done",
          result: { summary: summaryResult.response, skipped: false, conversationId, providerName, model, contextMessageCount },
        };
      }

      case "url.preview": {
        // Best-effort link preview WHILE TYPING (not a sent message) - the Voice-App queues
        // this as the user pauses typing on a detected URL. Uses the agent's OWN browser tool
        // (packages/tools/src/browser.ts) directly, bypassing the LLM entirely.
        //
        // Prefers real Open Graph/meta data (title, description, og:image, favicon) read via a
        // single evaluate() call over a full-page screenshot - that's what an actual "URL
        // preview" (a Slack/Discord/Twitter unfurl) is built from, and it's available for the
        // vast majority of real content (articles, videos, social posts) without the extra
        // render+screenshot round trip. A screenshot is only taken as a visual fallback when the
        // page has no og:image to show.
        const rawUrl = String(payload["url"] ?? "").trim();
        if (!rawUrl) throw new Error("url.preview: 'url' fehlt");
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(rawUrl);
        } catch {
          throw new Error("url.preview: ungueltige URL");
        }
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          throw new Error("url.preview: nur http/https URLs erlaubt");
        }

        const launch = await browserTool.execute({ action: "launch" });
        if (!launch.success) throw new Error(String(launch.error || "Browser konnte nicht gestartet werden"));
        const sessionId = (launch.data as { sessionId: string }).sessionId;

        try {
          const goto = await browserTool.execute({
            action: "goto",
            sessionId,
            url: rawUrl,
            waitUntil: "domcontentloaded",
            timeout: 12000,
          });
          if (!goto.success) throw new Error(String(goto.error || "Seite konnte nicht geladen werden"));

          // A few hundred ms for client-side-rendered pages to inject their <meta> tags -
          // domcontentloaded alone can fire before a JS-heavy SPA has added them.
          await new Promise((resolve) => setTimeout(resolve, 300));

          const meta = await browserTool.execute({
            action: "evaluate",
            sessionId,
            script: EXTRACT_URL_PREVIEW_META_SCRIPT,
          });
          if (!meta.success) throw new Error(String(meta.error || "Meta-Daten konnten nicht gelesen werden"));
          const metaData = ((meta.data as { result?: Record<string, unknown> } | null)?.result ?? {}) as {
            title?: string;
            description?: string | null;
            ogImage?: string | null;
            faviconUrl?: string | null;
          };

          let screenshotBase64: string | undefined;
          if (!metaData.ogImage) {
            const shot = await browserTool.execute({ action: "screenshot", sessionId, format: "jpeg" });
            if (shot.success) screenshotBase64 = (shot.data as { screenshot?: string } | null)?.screenshot;
          }

          return {
            status: "done",
            result: {
              title: metaData.title || rawUrl,
              description: metaData.description ?? undefined,
              url: rawUrl,
              faviconUrl: metaData.faviconUrl ?? undefined,
              previewImageUrl: metaData.ogImage ?? undefined,
              screenshotBase64,
            },
          };
        } finally {
          await browserTool.execute({ action: "close", sessionId }).catch(() => {});
        }
      }

      case "video.preview": {
        // Automatic video detection WHILE TYPING, like the social-media plugin's add_item but
        // with no question (no LLM call here - see the artifact-tool.ts doc comment: the LLM
        // only gets involved once the user actually sends the message, via chat.send's
        // artifactId path above). Extracts transcript+frames and stores them as an artifact
        // row, then discards the downloaded video immediately - it was only ever held in
        // memory, never written to the shared workspace, so there is nothing further to delete.
        const rawUrl = String(payload["url"] ?? "").trim();
        if (!rawUrl) throw new Error("video.preview: 'url' fehlt");
        try {
          new URL(rawUrl);
        } catch {
          throw new Error("video.preview: ungueltige URL");
        }

        const fetched = await fetchVideoFromUrl(rawUrl, deps.logger);
        if (!fetched) throw new Error("video.preview: Video konnte nicht geladen werden (nicht unterstuetzte URL oder Download fehlgeschlagen)");

        const analysis = await analyzeVideo(deps.db, deps.logger, fetched.buffer);
        if (!analysis) throw new Error("video.preview: Videoanalyse fehlgeschlagen (ffmpeg nicht verfuegbar oder Datei zu gross)");

        const frames = analysis.frames.map((frame) => ({ timestampSec: frame.timestampSec, base64: frame.buffer.toString("base64") }));
        const thumbnailDataUrl = frames[0] ? `data:image/jpeg;base64,${frames[0].base64}` : undefined;
        const conversationIdRaw = payload["conversationId"];
        const conversationId = typeof conversationIdRaw === "number" ? conversationIdRaw : undefined;

        const artifact = await deps.db.createArtifact({
          filename: `${fetched.title || fetched.platform}.mp4`,
          mimeType: "video/mp4",
          sizeBytes: fetched.buffer.length,
          path: null,
          sourceUrl: rawUrl,
          platform: fetched.platform,
          transcript: analysis.transcript,
          framesJson: JSON.stringify(frames),
          thumbnailDataUrl: thumbnailDataUrl ?? null,
          durationSec: analysis.durationSec,
          conversationId: conversationId ?? null,
          source: "voice_app",
          status: "ready",
          error: null,
        });

        return {
          status: "done",
          result: {
            artifactId: artifact.id,
            title: fetched.title || rawUrl,
            platform: fetched.platform,
            durationSec: analysis.durationSec,
            thumbnailDataUrl,
            transcript: analysis.transcript,
          },
        };
      }

      default:
        throw new Error(`Unbekannter Befehlstyp: ${command.type}`);
    }
  } catch (error) {
    return { status: "failed", result: { error: error instanceof Error ? error.message : String(error) } };
  }
}
