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
import { setPluginEnabled } from "@ducki/agent";
import { SHARED_WORKSPACE_ROOT } from "@ducki/tools";
import { installSkillFromSource } from "./skill-install.js";
import { transcribeAudioBuffer } from "./audio-transcription.js";

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
  getPlugins: () => LoadedPluginInfo[];
  requestPluginReload: () => void;
  createAgent: () => Promise<Agent>;
}

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
async function describeActiveProvider(db: DatabaseService): Promise<{ providerName: string; model: string }> {
  const providerName = ((await db.getSetting("DEFAULT_PROVIDER")) || "lmstudio").trim().toLowerCase();
  const modelSettingKey = MODEL_SETTING_BY_PROVIDER[providerName];
  const model = (modelSettingKey ? await db.getSetting(modelSettingKey) : undefined) || "unbekannt";
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
        const agent = await deps.createAgent();
        const conversationId = await resolveVoiceConversation(deps, agent, payload, `Cloud Control: ${message.slice(0, 40)}`);

        const attachmentBase64 = typeof payload["attachment"] === "string" ? payload["attachment"].trim() : "";
        const runStartedAt = Date.now();

        if (!attachmentBase64) {
          const runResult = await agent.run(message);
          const mediaAttachments = await findNewMediaFiles(runStartedAt);
          const { providerName, model } = await describeActiveProvider(deps.db);
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
            visionOnly: isImageMimeType(attachmentMimeType),
          });
          const mediaAttachments = await findNewMediaFiles(runStartedAt);
          const { providerName, model } = await describeActiveProvider(deps.db);
          const contextMessageCount = await deps.db.getMessageCount(conversationId);
          return { status: "done", result: { reply: runResult.response, conversationId, mediaAttachments, providerName, model, contextMessageCount } };
        } finally {
          await removeTempWorkspaceFile(attachmentPath);
        }
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

        const agent = await deps.createAgent();
        const conversationId = await resolveVoiceConversation(deps, agent, payload, `Voice: ${transcript.slice(0, 40)}`);
        const runStartedAt = Date.now();
        const runResult = await agent.run(transcript);
        const mediaAttachments = await findNewMediaFiles(runStartedAt);
        const { providerName, model } = await describeActiveProvider(deps.db);
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

      default:
        throw new Error(`Unbekannter Befehlstyp: ${command.type}`);
    }
  } catch (error) {
    return { status: "failed", result: { error: error instanceof Error ? error.message : String(error) } };
  }
}
