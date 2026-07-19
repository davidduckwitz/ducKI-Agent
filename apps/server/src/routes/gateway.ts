import { Router, type IRouter } from "express";
import type { Agent } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { createSpeechToTextProvider } from "@ducki/providers";
import { createApiError, createApiResponse } from "@ducki/shared";
import { runAgentWithRepairRetry } from "../lib/agent-retry.js";
import { createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { join, resolve } from "node:path";

export const gatewayRouter: IRouter = Router();

interface MessagingGatewayConfig {
  id: string;
  portal: "discord" | "telegram" | "slack" | "signal" | "custom";
  name: string;
  enabled: boolean;
  channelHint?: string;
  inboundLabel?: string;
  guildId?: string;
  userId?: string;
  appId?: string;
  publicKey?: string;
  metadata?: string;
  authToken?: string;
  webhookSecret?: string;
}

interface GatewayAttachmentInput {
  name: string;
  mimeType?: string;
  contentBase64?: string;
  url?: string;
  text?: string;
}

interface GatewayReactionInput {
  emoji: string;
  userName?: string;
}

interface GatewayInboundBody {
  portal?: string;
  externalConversationId?: string;
  sourceMessageId?: string;
  message?: string;
  text?: string;
  channelName?: string;
  userName?: string;
  projectId?: number;
  configId?: string;
  mode?: "text" | "voice" | "file";
  voiceTranscript?: string;
  voiceLanguage?: string;
  voiceDurationMs?: number;
  attachments?: GatewayAttachmentInput[];
  reactions?: GatewayReactionInput[];
  agentEmoji?: string;
}

interface DiscordInteractionPayload {
  externalConversationId: string;
  message: string;
  channelName?: string;
  userName?: string;
  interactionToken: string;
  applicationId: string;
}

const SHARED_WORKSPACE_ROOT = resolve(process.env["SHARED_WORKSPACE_PATH"] ?? "./shared-workspace");
const GATEWAY_UPLOAD_ROOT = resolve(SHARED_WORKSPACE_ROOT, "chat-uploads", "gateway");
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".ogg", ".oga", ".webm", ".flac", ".aac", ".opus"];

const SETTINGS_KEY = "MESSAGING_GATEWAYS";

function normalizeGatewayName(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "Messaging Gateway";
}

function normalizePortal(value: string): MessagingGatewayConfig["portal"] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "discord" || normalized === "telegram" || normalized === "slack" || normalized === "signal") {
    return normalized;
  }
  return "custom";
}

function parseGatewayConfigs(raw: string | undefined): MessagingGatewayConfig[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => item as Record<string, unknown>)
      .map((item, index) => ({
        id: String(item["id"] ?? `gateway_${index + 1}`),
        portal: normalizePortal(String(item["portal"] ?? "custom")),
        name: normalizeGatewayName(String(item["name"] ?? "Messaging Gateway")),
        enabled: Boolean(item["enabled"] ?? true),
        channelHint: item["channelHint"] ? String(item["channelHint"]) : undefined,
        inboundLabel: item["inboundLabel"] ? String(item["inboundLabel"]) : undefined,
        guildId: item["guildId"] ? String(item["guildId"]) : undefined,
        userId: item["userId"] ? String(item["userId"]) : undefined,
        appId: item["appId"] ? String(item["appId"]) : undefined,
        publicKey: item["publicKey"] ? String(item["publicKey"]) : undefined,
        metadata: item["metadata"] ? String(item["metadata"]) : undefined,
        authToken: item["authToken"] ? String(item["authToken"]) : undefined,
        webhookSecret: item["webhookSecret"] ? String(item["webhookSecret"]) : undefined,
      }));
  } catch {
    return [];
  }
}

function readRuntimeSetting(
  settings: Map<string, string>,
  key: string,
  envKey?: string,
  fallback?: string
): string | undefined {
  const fromSettings = settings.get(key)?.trim();
  if (fromSettings) return fromSettings;
  if (envKey) {
    const fromEnv = process.env[envKey]?.trim();
    if (fromEnv) return fromEnv;
  }
  if (fallback && fallback.trim()) return fallback;
  return undefined;
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function buildConversationName(config: MessagingGatewayConfig, externalConversationId: string): string {
  const hint = config.channelHint?.trim() || externalConversationId.trim();
  return `[${config.portal}] ${config.name} · ${hint}`;
}

function buildGatewaySessionName(baseName: string): string {
  return `${baseName} · session ${new Date().toISOString()}`;
}

function parseNewSessionCommand(
  rawMessage: string,
  options: { allowBare?: boolean } = {}
): { requestedNewSession: boolean; forwardedMessage: string; commandOnly: boolean } {
  const message = rawMessage.trim();
  if (!message) {
    return { requestedNewSession: false, forwardedMessage: "", commandOnly: false };
  }

  const markerMatch = message.match(/^-new-(?:\s+|$)/i);
  const bareMatch = options.allowBare ? message.match(/^new(?:\s+|$)/i) : null;
  const match = markerMatch ?? bareMatch;
  if (!match) {
    return { requestedNewSession: false, forwardedMessage: message, commandOnly: false };
  }

  const forwardedMessage = message.slice(match[0].length).trim();
  return {
    requestedNewSession: true,
    forwardedMessage,
    commandOnly: forwardedMessage.length === 0,
  };
}

function buildNewSessionReply(): string {
  return "Neue Chat-Session gestartet. Sende jetzt deine naechste Nachricht ohne alten Kontext.";
}

function resolveGatewayExternalConversationId(config: MessagingGatewayConfig, providedExternalConversationId: string): string {
  const configuredChannelHint = config.channelHint?.trim();
  const provided = providedExternalConversationId.trim();

  if (!provided) {
    return configuredChannelHint ?? "";
  }

  if (configuredChannelHint && /^demo-/i.test(provided)) {
    return configuredChannelHint;
  }

  return provided;
}

function resolveGatewayChannelName(config: MessagingGatewayConfig, providedChannelName?: string): string | undefined {
  const channelName = providedChannelName?.trim();
  if (channelName) return channelName;
  return config.channelHint?.trim() || undefined;
}

function resolveGatewayUserName(config: MessagingGatewayConfig, providedUserName?: string): string | undefined {
  const userName = providedUserName?.trim();
  if (userName) return userName;
  return config.inboundLabel?.trim() || undefined;
}

function resolveDiscordPublicKey(config: MessagingGatewayConfig): string | undefined {
  const envKey = process.env["DISCORD_PUBLIC_KEY"]?.trim();
  if (envKey) return envKey;
  const configuredKey = config.publicKey?.trim();
  return configuredKey || undefined;
}

function shouldVerifyDiscordRequest(body: unknown, headers: Record<string, string | string[] | undefined>): boolean {
  const payload = body && typeof body === "object" ? body as Record<string, unknown> : undefined;
  const interactionType = Number(payload?.["type"] ?? 0);
  return interactionType > 0 || Boolean(headers["x-signature-ed25519"] && headers["x-signature-timestamp"]);
}

function verifyDiscordRequestSignature(config: MessagingGatewayConfig, rawBody: string, timestamp: string, signature: string): boolean {
  const publicKeyHex = resolveDiscordPublicKey(config);
  if (!publicKeyHex) return false;
  const keyBytes = Buffer.from(publicKeyHex, "hex");
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const publicKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, keyBytes]),
    format: "der",
    type: "spki",
  });

  return verify(
    null,
    Buffer.from(`${timestamp}${rawBody}`),
    publicKey,
    Buffer.from(signature, "hex")
  );
}

function gatewayConversationPrefix(config: MessagingGatewayConfig): string {
  return `[${config.portal}] ${config.name}`;
}

function ensureGatewayUploadRoot(): void {
  if (!existsSync(GATEWAY_UPLOAD_ROOT)) {
    mkdirSync(GATEWAY_UPLOAD_ROOT, { recursive: true });
  }
}

function sanitizeFileSegment(input: string): string {
  return input.replaceAll(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "file";
}

async function readAttachmentBuffer(attachment: GatewayAttachmentInput, botToken?: string): Promise<Buffer | undefined> {
  if (attachment.contentBase64) {
    return Buffer.from(attachment.contentBase64, "base64");
  }

  const sourceUrl = String(attachment.url ?? "").trim();
  if (!sourceUrl) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(sourceUrl, {
      method: "GET",
      headers: botToken ? { Authorization: `Bot ${botToken}` } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Attachment download failed: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timeout);
  }
}

async function saveGatewayAttachment(
  config: MessagingGatewayConfig,
  conversationId: string,
  attachment: GatewayAttachmentInput,
  index: number
): Promise<{ path?: string; storedName: string }> {
  ensureGatewayUploadRoot();
  const safeConfigId = sanitizeFileSegment(config.id);
  const safeConversationId = sanitizeFileSegment(conversationId);
  const folder = join(GATEWAY_UPLOAD_ROOT, safeConfigId, safeConversationId);
  if (!existsSync(folder)) {
    mkdirSync(folder, { recursive: true });
  }

  const storedName = `${index + 1}-${sanitizeFileSegment(attachment.name || "attachment")}`;
  const relativePath = `chat-uploads/gateway/${safeConfigId}/${safeConversationId}/${storedName}`;
  const filePath = resolve(SHARED_WORKSPACE_ROOT, relativePath);
  try {
    const botToken = config.portal === "discord" ? resolveDiscordBotToken(config) : undefined;
    const fileBuffer = await readAttachmentBuffer(attachment, botToken);
    if (fileBuffer && fileBuffer.length > 0) {
      writeFileSync(filePath, fileBuffer);
      return { path: relativePath, storedName };
    }
  } catch (error) {
    console.warn("Gateway attachment persistence failed", {
      name: attachment.name,
      url: attachment.url,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { storedName };
}

function buildGatewayMessageText(body: GatewayInboundBody): string {
  const text = String(body.message ?? body.text ?? body.voiceTranscript ?? "").trim();
  if (text) return text;
  if (body.attachments && body.attachments.length > 0) {
    return body.attachments.map((attachment) => attachment.text?.trim() || attachment.name).join("\n");
  }
  return "";
}

function isAudioAttachment(attachment: GatewayAttachmentInput): boolean {
  const mimeType = String(attachment.mimeType ?? "").toLowerCase();
  if (mimeType.startsWith("audio/")) return true;
  const name = String(attachment.name ?? "").toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext));
}

type DiscordVoiceProviderName = "openai" | "ollama" | "silero" | "local" | "nodejs-whisper";

interface VoiceTranscriptionDiagnostics {
  providerName: DiscordVoiceProviderName;
  lastError?: string;
}

function resolveDiscordVoiceProviderName(settings: Map<string, string>): DiscordVoiceProviderName {
  const requested = (
    readRuntimeSetting(settings, "DISCORD_VOICE_STT_PROVIDER", "DISCORD_VOICE_STT_PROVIDER")
    ?? readRuntimeSetting(settings, "DEFAULT_SPEECH_TO_TEXT_PROVIDER", "DEFAULT_SPEECH_TO_TEXT_PROVIDER", "local")
    ?? "local"
  ).trim().toLowerCase();

  if (requested === "openai") return "openai";
  if (requested === "ollama") return "ollama";
  if (requested === "silero") return "silero";
  if (requested === "nodejs-whisper" || requested === "nodewhisper") return "nodejs-whisper";
  return "local";
}

function buildLocalCommandSpeechProvider(settings: Map<string, string>, model?: string) {
  const command = readRuntimeSetting(settings, "DISCORD_VOICE_STT_COMMAND", "DISCORD_VOICE_STT_COMMAND")
    || readRuntimeSetting(settings, "LOCAL_STT_COMMAND", "LOCAL_STT_COMMAND");
  const argsTemplate = readRuntimeSetting(settings, "DISCORD_VOICE_STT_ARGS", "DISCORD_VOICE_STT_ARGS")
    || readRuntimeSetting(settings, "LOCAL_STT_ARGS", "LOCAL_STT_ARGS", "{input}")
    || "{input}";
  const timeoutRaw = readRuntimeSetting(settings, "DISCORD_VOICE_STT_TIMEOUT_MS", "DISCORD_VOICE_STT_TIMEOUT_MS")
    || readRuntimeSetting(settings, "LOCAL_STT_TIMEOUT_MS", "LOCAL_STT_TIMEOUT_MS");
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : undefined;
  let args: string[] | undefined;
  if (argsTemplate.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(argsTemplate) as unknown;
      if (Array.isArray(parsed)) {
        args = parsed.map((part) => String(part));
      }
    } catch {
      args = undefined;
    }
  }

  return createSpeechToTextProvider({
    name: "local",
    command,
    args,
    model: model ?? argsTemplate,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  });
}

function resolveDiscordVoiceProvider(settings: Map<string, string>) {
  const name = resolveDiscordVoiceProviderName(settings);
  const model = readRuntimeSetting(settings, "DISCORD_VOICE_STT_MODEL", "DISCORD_VOICE_STT_MODEL");

  if (name === "openai") {
    return createSpeechToTextProvider({
      name,
      apiKey: readRuntimeSetting(settings, "OPENAI_API_KEY", "OPENAI_API_KEY"),
      baseUrl: readRuntimeSetting(settings, "OPENAI_BASE_URL", "OPENAI_BASE_URL", "https://api.openai.com/v1"),
      model,
    });
  }

  if (name === "nodejs-whisper") {
    return createSpeechToTextProvider({
      name,
      model: model ?? readRuntimeSetting(settings, "NODEJS_WHISPER_MODEL_NAME", "NODEJS_WHISPER_MODEL_NAME", "base"),
      modelRootPath: readRuntimeSetting(settings, "NODEJS_WHISPER_MODEL_ROOT_PATH", "NODEJS_WHISPER_MODEL_ROOT_PATH"),
      autoDownloadModel: parseBoolean(
        readRuntimeSetting(settings, "NODEJS_WHISPER_AUTO_DOWNLOAD", "NODEJS_WHISPER_AUTO_DOWNLOAD", "true"),
        true
      ),
      withCuda: parseBoolean(
        readRuntimeSetting(settings, "NODEJS_WHISPER_USE_CUDA", "NODEJS_WHISPER_USE_CUDA", "false"),
        false
      ),
      timeoutMs: Number.parseInt(
        readRuntimeSetting(settings, "NODEJS_WHISPER_TIMEOUT_MS", "NODEJS_WHISPER_TIMEOUT_MS", "180000") ?? "180000",
        10
      ),
    });
  }

  const baseUrl = name === "ollama"
    ? readRuntimeSetting(settings, "OLLAMA_BASE_URL", "OLLAMA_BASE_URL", "http://localhost:11434")
    : readRuntimeSetting(settings, "SILERO_BASE_URL", "SILERO_BASE_URL") ?? readRuntimeSetting(settings, "OLLAMA_BASE_URL", "OLLAMA_BASE_URL", "http://localhost:11434");

  if (name === "local") {
    return buildLocalCommandSpeechProvider(settings, model);
  }

  return createSpeechToTextProvider({
    name,
    baseUrl,
    model,
  });
}

async function transcribeDiscordVoiceAttachments(
  config: MessagingGatewayConfig,
  body: GatewayInboundBody,
  settings: Map<string, string>
): Promise<VoiceTranscriptionDiagnostics> {
  const providerName = resolveDiscordVoiceProviderName(settings);
  if (body.voiceTranscript?.trim()) return { providerName };
  if ((body.portal ?? "").toLowerCase() !== "discord") return { providerName };

  const audioAttachments = (body.attachments ?? []).filter(isAudioAttachment);
  if (audioAttachments.length === 0) return { providerName };

  const provider = resolveDiscordVoiceProvider(settings);
  const localFallbackProvider = providerName === "nodejs-whisper"
    ? buildLocalCommandSpeechProvider(settings, readRuntimeSetting(settings, "DISCORD_VOICE_STT_MODEL", "DISCORD_VOICE_STT_MODEL"))
    : undefined;
  const botToken = resolveDiscordBotToken(config);
  const transcripts: string[] = [];
  let lastError: string | undefined;

  for (const attachment of audioAttachments) {
    try {
      const audioBuffer = await readAttachmentBuffer(attachment, botToken);
      if (!audioBuffer || audioBuffer.length === 0) continue;
      const transcript = (await provider.transcribe(audioBuffer, { language: body.voiceLanguage })).trim();
      if (!transcript) continue;
      attachment.text = attachment.text?.trim() || transcript;
      transcripts.push(transcript);
    } catch (error) {
      const primaryError = error instanceof Error ? error.message : String(error);
      lastError = primaryError;

      if (localFallbackProvider) {
        try {
          const audioBuffer = await readAttachmentBuffer(attachment, botToken);
          if (audioBuffer && audioBuffer.length > 0) {
            const fallbackTranscript = (await localFallbackProvider.transcribe(audioBuffer, { language: body.voiceLanguage })).trim();
            if (fallbackTranscript) {
              attachment.text = attachment.text?.trim() || fallbackTranscript;
              transcripts.push(fallbackTranscript);
              continue;
            }
          }
        } catch (fallbackError) {
          const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          lastError = `${primaryError} | local-fallback: ${fallbackErrorMessage}`;
        }
      }

      console.warn("Discord voice transcription failed", {
        attachment: attachment.name,
        error: lastError,
      });
    }
  }

  if (transcripts.length > 0) {
    body.voiceTranscript = transcripts.join("\n\n");
    if (!body.mode) body.mode = "voice";
  }

  return { providerName, lastError };
}

function buildGatewayMetadata(config: MessagingGatewayConfig, body: GatewayInboundBody, attachments: Array<{ name: string; path?: string; url?: string; mimeType?: string }>) {
  return {
    source: "gateway",
    portal: config.portal,
    configId: config.id,
    channelName: body.channelName,
    externalConversationId: body.externalConversationId,
    userName: body.userName,
    mode: body.mode ?? (attachments.length > 0 ? "file" : body.voiceTranscript ? "voice" : "text"),
    voice: body.voiceTranscript
      ? {
          transcript: body.voiceTranscript,
          language: body.voiceLanguage,
          durationMs: body.voiceDurationMs,
        }
      : undefined,
    attachments,
    reactions: body.reactions,
    agentEmoji: body.agentEmoji,
    guildId: config.guildId,
    configuredUserId: config.userId,
    appId: config.appId,
      publicKey: config.publicKey,
    configMetadata: config.metadata,
  };
}

function pickAgentReaction(resultText: string): string {
  const normalized = resultText.toLowerCase();
  if (normalized.includes("fehler") || normalized.includes("error") || normalized.includes("failed")) return "⚠️";
  if (normalized.includes("done") || normalized.includes("fertig") || normalized.includes("completed") || normalized.includes("success")) return "✅";
  if (normalized.includes("frage") || normalized.includes("question") || normalized.includes("?")) return "🤔";
  return "💬";
}

function buildGatewayProcessingFallbackReply(
  errorMessage: string,
  attachmentPaths: string[],
  hasAudioAttachments: boolean,
  hasVoiceTranscript: boolean,
  voiceTranscript?: string
): string {
  const isRateLimited = /(^|\s)429(\s|$)|rate\s*limit|too\s*many\s*requests/i.test(errorMessage);
  const intro = isRateLimited
    ? "Ich bin gerade provider-seitig rate-limited (429) und konnte deine Anfrage nicht vollständig ausführen."
    : "Ich konnte deine Anfrage gerade nicht vollständig ausführen.";
  const voiceHint = hasAudioAttachments && !hasVoiceTranscript
    ? "Hinweis: Fuer Voice-Transkription ist ein lokales STT-Kommando noetig (LOCAL_STT_COMMAND/LOCAL_STT_ARGS)."
    : undefined;
  const filesHint = attachmentPaths.length > 0
    ? `Datei gespeichert unter: ${attachmentPaths.join(", ")}`
    : undefined;
  const transcriptHint = isRateLimited && hasVoiceTranscript && voiceTranscript?.trim()
    ? `Transkript (ungefiltert): ${voiceTranscript.trim()}`
    : undefined;
  const technical = `Technischer Fehler: ${errorMessage}`;

  return [intro, voiceHint, filesHint, transcriptHint, technical]
    .filter((line): line is string => Boolean(line && line.trim()))
    .join("\n");
}

function buildVoiceTranscriptionMissingReply(
  attachmentPaths: string[],
  providerName: DiscordVoiceProviderName,
  errorMessage?: string
): string {
  const fileHint = attachmentPaths.length > 0
    ? `Datei gespeichert unter: ${attachmentPaths.join(", ")}`
    : "Datei wurde empfangen, aber es konnte kein lokaler Speicherpfad ermittelt werden.";

  const providerHint = providerName === "nodejs-whisper"
    ? "Bitte pruefe DISCORD_VOICE_STT_PROVIDER=nodejs-whisper sowie NODEJS_WHISPER_MODEL_NAME und NODEJS_WHISPER_AUTO_DOWNLOAD. Falls CMake fehlt, stelle auf local um oder installiere CMake Build Tools."
    : providerName === "local"
      ? "Bitte setze LOCAL_STT_COMMAND und LOCAL_STT_ARGS (optional DISCORD_VOICE_STT_COMMAND/DISCORD_VOICE_STT_ARGS)."
      : `Bitte pruefe die STT-Provider-Konfiguration fuer '${providerName}' in den Settings.`;

  const technicalHint = errorMessage ? `Technischer STT-Fehler: ${errorMessage}` : undefined;

  return [
    `Ich konnte die Sprachnachricht nicht transkribieren (Provider: ${providerName}).`,
    providerHint,
    fileHint,
    technicalHint,
  ].join("\n");
}

function getRequestOrigin(req: { headers: Record<string, string | string[] | undefined>; protocol: string }): string {
  const forwardedProto = Array.isArray(req.headers["x-forwarded-proto"]) ? req.headers["x-forwarded-proto"][0] : req.headers["x-forwarded-proto"];
  const forwardedHost = Array.isArray(req.headers["x-forwarded-host"]) ? req.headers["x-forwarded-host"][0] : req.headers["x-forwarded-host"];
  const host = forwardedHost ?? req.headers.host ?? "localhost:3001";
  const protocol = forwardedProto ?? req.protocol ?? "http";
  return `${protocol}://${host}`;
}

function buildWebhookUrl(req: { headers: Record<string, string | string[] | undefined>; protocol: string }, portal: string, id: string): string {
  return `${getRequestOrigin(req)}/api/gateway/${encodeURIComponent(portal)}/${encodeURIComponent(id)}/webhook`;
}

function parseTelegramUpdate(body: unknown): { externalConversationId: string; message: string; channelName?: string; userName?: string } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const update = body as Record<string, unknown>;
  const message = (update["message"] ?? update["edited_message"] ?? update["channel_post"]) as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return undefined;
  const text = String(message["text"] ?? message["caption"] ?? "").trim();
  if (!text) return undefined;
  const chat = message["chat"] as Record<string, unknown> | undefined;
  const from = message["from"] as Record<string, unknown> | undefined;
  const chatId = String(chat?.["id"] ?? "").trim();
  if (!chatId) return undefined;
  return {
    externalConversationId: chatId,
    message: text,
    channelName: String(chat?.["title"] ?? chat?.["username"] ?? chatId).trim() || chatId,
    userName: String(from?.["username"] ?? from?.["first_name"] ?? from?.["last_name"] ?? "").trim() || undefined,
  };
}

function parseDiscordBridgePayload(body: unknown): { externalConversationId: string; message: string; channelName?: string; userName?: string } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const payload = body as Record<string, unknown>;
  const content = String(payload["content"] ?? payload["message"] ?? "").trim();
  if (!content) return undefined;
  const channel = payload["channel"] as Record<string, unknown> | undefined;
  const author = payload["author"] as Record<string, unknown> | undefined;
  const conversationId = String(channel?.["id"] ?? payload["channelId"] ?? payload["conversationId"] ?? "").trim();
  if (!conversationId) return undefined;
  return {
    externalConversationId: conversationId,
    message: content,
    channelName: String(channel?.["name"] ?? payload["channelName"] ?? conversationId).trim() || conversationId,
    userName: String(author?.["username"] ?? payload["userName"] ?? "").trim() || undefined,
  };
}

function parseDiscordInteractionPayload(body: unknown): DiscordInteractionPayload | undefined {
  if (!body || typeof body !== "object") return undefined;
  const payload = body as Record<string, unknown>;
  const interactionType = Number(payload["type"] ?? 0);
  if (![2, 3].includes(interactionType)) return undefined;

  const applicationId = String(payload["application_id"] ?? "").trim();
  const interactionToken = String(payload["token"] ?? "").trim();
  const channelId = String(payload["channel_id"] ?? "").trim();
  const guildId = String(payload["guild_id"] ?? "").trim();
  const member = payload["member"] as Record<string, unknown> | undefined;
  const user = (member?.["user"] as Record<string, unknown> | undefined) ?? (payload["user"] as Record<string, unknown> | undefined);
  const userId = String(user?.["id"] ?? "").trim();
  if (!applicationId || !interactionToken) return undefined;

  const data = payload["data"] as Record<string, unknown> | undefined;
  const commandName = String(data?.["name"] ?? "discord").trim() || "discord";
  const options = Array.isArray(data?.["options"]) ? (data?.["options"] as Array<Record<string, unknown>>) : [];
  const optionParts = options
    .map((option) => {
      const name = String(option?.["name"] ?? "").trim();
      const value = option?.["value"];
      if (!name || value === undefined || value === null) return undefined;
      return `${name}: ${String(value).trim()}`;
    })
    .filter((value): value is string => Boolean(value));
  const primaryOption = options.find((option) => typeof option?.["value"] === "string");
  const message = String(primaryOption?.["value"] ?? [commandName, ...optionParts].join(" | ")).trim();
  if (!message) return undefined;

  const externalConversationId = channelId || guildId || userId || `interaction-${applicationId}`;
  const channelName = String(payload["channel_name"] ?? channelId ?? guildId ?? userId).trim() || externalConversationId;
  const userName = String(user?.["username"] ?? member?.["nick"] ?? "").trim() || undefined;

  return {
    externalConversationId,
    message,
    channelName,
    userName,
    interactionToken,
    applicationId,
  };
}


async function getOrCreateGatewayConversation(
  db: DatabaseService,
  config: MessagingGatewayConfig,
  externalConversationId: string,
  projectId?: number,
  forceNew = false
): Promise<number> {
  const prefix = gatewayConversationPrefix(config);
  const conversations = await db.listConversations(projectId);
  const matches = conversations.filter((conversation) => conversation.name.startsWith(prefix) && conversation.name.includes(externalConversationId));
  if (!forceNew && matches.length > 0) {
    const newest = matches.reduce((latest, current) => (current.id > latest.id ? current : latest));
    return newest.id;
  }

  const created = await db.createConversation({
    name: forceNew
      ? buildGatewaySessionName(buildConversationName(config, externalConversationId))
      : buildConversationName(config, externalConversationId),
    projectId,
  });
  return created.id;
}

async function appendGatewayEvent(
  db: DatabaseService,
  conversationId: number,
  content: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await db.addMessage({
    conversationId,
    role: "event",
    content,
    metadata: JSON.stringify(metadata),
  });

  const eventType = typeof metadata["type"] === "string" ? metadata["type"] : "event";
  const level = eventType === "outbound_error" || eventType === "reaction_error" || eventType === "processing_error"
    ? "error"
    : eventType === "reaction_skipped"
      ? "warn"
      : eventType === "inbound" || eventType === "outbound_reply" || eventType === "reaction" || eventType === "reaction_set"
        ? "info"
        : "debug";
  const portal = typeof metadata["portal"] === "string" ? metadata["portal"] : "gateway";

  await db.addLog({
    level,
    message: `[Gateway ${portal}] ${content}`,
    context: JSON.stringify({
      conversationId,
      ...metadata,
    }),
  }).catch(() => {
    // Keep gateway handling resilient even if log persistence fails.
  });
}

async function sendTelegramReply(botToken: string, chatId: string, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${response.statusText}`);
  }
}

async function readResponseBody(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const parsed = await response.json() as unknown;
      return JSON.stringify(parsed);
    }
    const text = await response.text();
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

function encodeDiscordReactionEmoji(emoji: string): string {
  const trimmed = emoji.trim();
  const custom = trimmed.match(/^<a?:([^:>]+):(\d+)>$/);
  if (custom) {
    const customName = custom[1] ?? "emoji";
    const customId = custom[2] ?? "";
    return encodeURIComponent(`${customName}:${customId}`);
  }
  return encodeURIComponent(trimmed);
}

const DISCORD_MESSAGE_MAX_CHARS = 3900;

function splitForDiscord(content: string, maxChars = DISCORD_MESSAGE_MAX_CHARS): string[] {
  const text = content.trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut < Math.floor(maxChars * 0.6)) {
      cut = rest.lastIndexOf(" ", maxChars);
    }
    if (cut < Math.floor(maxChars * 0.4)) {
      cut = maxChars;
    }

    const part = rest.slice(0, cut).trim();
    if (part.length > 0) {
      chunks.push(part);
    }
    rest = rest.slice(cut).trimStart();
  }

  if (rest.length > 0) {
    chunks.push(rest);
  }

  return chunks;
}

function resolveDiscordBotToken(config: MessagingGatewayConfig): string | undefined {
  const gatewayToken = config.authToken?.trim();
  if (gatewayToken) return gatewayToken;
  const envToken = process.env["DISCORD_BOT_TOKEN"]?.trim();
  return envToken || undefined;
}

async function addDiscordMessageReaction(botToken: string, channelId: string, messageId: string, emoji: string): Promise<void> {
  const encodedEmoji = encodeDiscordReactionEmoji(emoji);
  const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodedEmoji}/@me`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
    },
  });

  if (!response.ok) {
    const body = await readResponseBody(response);
    throw new Error(`Discord reaction failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`);
  }
}

async function applyDiscordReactionWithLog(
  db: DatabaseService,
  conversationId: number,
  config: MessagingGatewayConfig,
  channelId: string,
  sourceMessageId: string | undefined,
  emoji: string,
  phase: "inbound" | "processed" | "error"
): Promise<void> {
  if (config.portal !== "discord") return;

  if (!sourceMessageId?.trim()) {
    await appendGatewayEvent(db, conversationId, "Reaction skipped (missing source message id)", {
      source: "gateway",
      type: "reaction_skipped",
      direction: "reaction",
      portal: config.portal,
      configId: config.id,
      phase,
      emoji,
      reason: "missing_source_message_id",
      channelId,
    });
    return;
  }

  const botToken = resolveDiscordBotToken(config);
  if (!botToken) {
    await appendGatewayEvent(db, conversationId, "Reaction skipped (missing bot token)", {
      source: "gateway",
      type: "reaction_skipped",
      direction: "reaction",
      portal: config.portal,
      configId: config.id,
      phase,
      emoji,
      reason: "missing_bot_token",
      channelId,
      sourceMessageId,
    });
    return;
  }

  try {
    await addDiscordMessageReaction(botToken, channelId, sourceMessageId, emoji);
    await appendGatewayEvent(db, conversationId, `Reaction set: ${emoji}`, {
      source: "gateway",
      type: "reaction_set",
      direction: "reaction",
      portal: config.portal,
      configId: config.id,
      phase,
      emoji,
      channelId,
      sourceMessageId,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await appendGatewayEvent(db, conversationId, `Reaction failed: ${emoji}`, {
      source: "gateway",
      type: "reaction_error",
      direction: "reaction",
      portal: config.portal,
      configId: config.id,
      phase,
      emoji,
      channelId,
      sourceMessageId,
      error: errorMessage,
    });
  }
}

async function sendDiscordReply(botToken: string, channelId: string, text: string): Promise<void> {
  const chunks = splitForDiscord(text);
  for (const chunk of chunks) {
    const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: chunk }),
    });

    if (!response.ok) {
      const body = await readResponseBody(response);
      throw new Error(`Discord send message failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`);
    }
  }
}

async function updateDiscordInteractionResponse(applicationId: string, interactionToken: string, text: string): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}/messages/@original`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: text }),
  });

  if (!response.ok) {
    const body = await readResponseBody(response);
    throw new Error(`Discord interaction update failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`);
  }
}

async function sendWebhookReply(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Webhook send failed: ${response.status} ${response.statusText}`);
  }
}

async function sendGatewayReply(
  config: MessagingGatewayConfig,
  externalConversationId: string,
  replyText: string,
  reaction: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const normalizedReply = replyText.trim();
  if (!normalizedReply) return;

  const genericPayload = {
    portal: config.portal,
    configId: config.id,
    externalConversationId,
    replyText: normalizedReply,
    reaction,
    metadata,
  };

  if (config.portal === "telegram") {
    if (!config.authToken) throw new Error("Telegram gateway requires authToken as bot token for outbound replies");
    await sendTelegramReply(config.authToken, externalConversationId, normalizedReply);
    return;
  }

  if (config.portal === "discord") {
    const botToken = resolveDiscordBotToken(config);
    if (botToken) {
      await sendDiscordReply(botToken, externalConversationId, normalizedReply);
      return;
    }
    if (config.webhookSecret && /^https?:\/\//i.test(config.webhookSecret)) {
      await sendWebhookReply(config.webhookSecret, genericPayload);
      return;
    }
    throw new Error("Discord gateway requires DISCORD_BOT_TOKEN or authToken as bot token, or webhookSecret as webhook URL");
  }

  if (config.webhookSecret && /^https?:\/\//i.test(config.webhookSecret)) {
    await sendWebhookReply(config.webhookSecret, genericPayload);
    return;
  }

  if (config.authToken && /^https?:\/\//i.test(config.authToken)) {
    await sendWebhookReply(config.authToken, genericPayload);
    return;
  }

  throw new Error(`Gateway portal '${config.portal}' does not have an outbound transport configured`);
}

gatewayRouter.get("/", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const configs = parseGatewayConfigs(await db.getSetting(SETTINGS_KEY));
    const conversations = await db.listConversations();
    const gatewayConversations = conversations.filter((conversation) => conversation.name.startsWith("[") && conversation.name.includes("·"));
    const endpoints = configs.map((config) => ({
      id: config.id,
      portal: config.portal,
      webhookUrl: buildWebhookUrl(req, config.portal, config.id),
    }));
    res.json(createApiResponse({ configs, conversations: gatewayConversations, endpoints }));
  } catch (error) {
    next(error);
  }
});

gatewayRouter.put("/", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const { configs } = req.body as { configs?: MessagingGatewayConfig[] };
    if (!Array.isArray(configs)) {
      res.status(400).json(createApiError("configs array is required"));
      return;
    }

    const normalized = configs.map((item, index) => ({
      id: String(item?.id ?? `gateway_${index + 1}`),
      portal: normalizePortal(String(item?.portal ?? "custom")),
      name: normalizeGatewayName(String(item?.name ?? "Messaging Gateway")),
      enabled: Boolean(item?.enabled ?? true),
      channelHint: item?.channelHint ? String(item.channelHint) : undefined,
      inboundLabel: item?.inboundLabel ? String(item.inboundLabel) : undefined,
      guildId: item?.guildId ? String(item.guildId) : undefined,
      userId: item?.userId ? String(item.userId) : undefined,
      appId: item?.appId ? String(item.appId) : undefined,
      publicKey: item?.publicKey ? String(item.publicKey) : undefined,
      metadata: item?.metadata ? String(item.metadata) : undefined,
      authToken: item?.authToken ? String(item.authToken) : undefined,
      webhookSecret: item?.webhookSecret ? String(item.webhookSecret) : undefined,
    }));

    await db.setSetting(SETTINGS_KEY, JSON.stringify(normalized));
    res.json(createApiResponse({ saved: true, configs: normalized }));
  } catch (error) {
    next(error);
  }
});

gatewayRouter.post("/inbound", async (req, res, next) => {
  let runId: string | undefined;
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const createAgent = req.app.locals["createAgent"] as (() => Agent) | undefined;
    const agent = createAgent ? createAgent() : (req.app.locals["agent"] as Agent);
    const agentRegistry = req.app.locals["agentRegistry"] as {
      register: (entry: { source: "chat_http" | "chat_ws" | "task_run" | "gateway_inbound"; conversationId?: number; taskId?: number; socketId?: string; label?: string }) => string;
      unregister: (id: string) => void;
    };

    const body = req.body as GatewayInboundBody;

    const portal = normalizePortal(String(body.portal ?? "custom"));
    const providedExternalConversationId = String(body.externalConversationId ?? "").trim();
    if (!providedExternalConversationId && !body.configId) {
      res.status(400).json(createApiError("externalConversationId or configId is required"));
      return;
    }

    const configs = parseGatewayConfigs(await db.getSetting(SETTINGS_KEY));
    const config = configs.find((entry) => entry.portal === portal && (body.configId ? entry.id === body.configId : entry.enabled)) ?? {
      id: `runtime-${portal}`,
      portal,
      name: normalizeGatewayName(`${portal} gateway`),
      enabled: true,
      channelHint: body.channelName,
      inboundLabel: body.userName,
    };

    const allSettings = await db.getAllSettings();
    const settingsMap = new Map(allSettings.map((entry) => [entry.key, entry.value]));

    const transcriptionDiagnostics = await transcribeDiscordVoiceAttachments(config, body, settingsMap);
    const message = buildGatewayMessageText(body);
    if (!message) {
      res.status(400).json(createApiError("message is required"));
      return;
    }
    const inboundSessionCommand = config.portal === "discord"
      ? parseNewSessionCommand(message)
      : { requestedNewSession: false, forwardedMessage: message, commandOnly: false };

    const externalConversationId = resolveGatewayExternalConversationId(config, providedExternalConversationId);
    const channelName = resolveGatewayChannelName(config, body.channelName);
    const userName = resolveGatewayUserName(config, body.userName);
    if (!externalConversationId) {
      res.status(400).json(createApiError("externalConversationId or channelHint is required"));
      return;
    }

    const conversationId = await getOrCreateGatewayConversation(
      db,
      config,
      externalConversationId,
      body.projectId,
      inboundSessionCommand.requestedNewSession
    );
    const attachmentRecords = await Promise.all((body.attachments ?? []).map(async (attachment, index) => {
      const saved = await saveGatewayAttachment(config, externalConversationId, attachment, index);
      return {
        name: attachment.name,
        path: saved.path,
        url: attachment.url,
        mimeType: attachment.mimeType,
      };
    }));

    await agent.loadConversation(conversationId);
    runId = agentRegistry.register({
      source: "gateway_inbound",
      conversationId,
      label: `${config.portal}:${config.name}`,
    });

    const attachmentHints = attachmentRecords
      .filter((record) => Boolean(record.path))
      .map((record) => `Shared-Workspace-Datei: ${record.path}`);

    const hasAudioAttachments = (body.attachments ?? []).some(isAudioAttachment);
    const hasVoiceTranscript = Boolean(body.voiceTranscript?.trim());
    const explicitTextMessage = String(body.message ?? body.text ?? "").trim();
    const useTranscriptOnlyForAgent = hasAudioAttachments && hasVoiceTranscript && explicitTextMessage.length === 0;
    const attachmentPaths = attachmentRecords
      .map((record) => record.path)
      .filter((value): value is string => Boolean(value));

    const transcriptText = String(body.voiceTranscript ?? "").trim();
    const agentMessageBase = useTranscriptOnlyForAgent && transcriptText.length > 0
      ? transcriptText
      : message;
    const effectiveAgentMessageBase = inboundSessionCommand.requestedNewSession
      ? inboundSessionCommand.forwardedMessage
      : agentMessageBase;

    const filteredAttachmentHints = attachmentHints.filter((_, index) => {
      if (!useTranscriptOnlyForAgent) return true;
      const attachment = body.attachments?.[index];
      return attachment ? !isAudioAttachment(attachment) : true;
    });

    const messageWithAttachmentHints = filteredAttachmentHints.length > 0
      ? `${effectiveAgentMessageBase}\n${filteredAttachmentHints.join("\n")}`.trim()
      : effectiveAgentMessageBase;

    if (inboundSessionCommand.commandOnly) {
      const resetReply = buildNewSessionReply();
      await appendGatewayEvent(db, conversationId, "Gateway session reset", {
        source: "gateway",
        type: "session_reset",
        portal: config.portal,
        configId: config.id,
        externalConversationId,
        channelName,
        userName,
      });

      await applyDiscordReactionWithLog(
        db,
        conversationId,
        config,
        externalConversationId,
        body.sourceMessageId,
        "♻️",
        "processed"
      );

      await sendGatewayReply(
        config,
        externalConversationId,
        resetReply,
        "♻️",
        {
          source: "gateway",
          portal: config.portal,
          configId: config.id,
          channelName,
          userName,
          mode: body.mode ?? "text",
          command: "new_session",
        }
      );

      res.json(createApiResponse({
        conversationId,
        replyText: resetReply,
        result: { response: resetReply, command: "new_session", reset: true },
        portal: config.portal,
        configId: config.id,
        reaction: "♻️",
      }));
      return;
    }

    if (hasAudioAttachments && !hasVoiceTranscript) {
      const responseText = buildVoiceTranscriptionMissingReply(
        attachmentPaths,
        transcriptionDiagnostics.providerName,
        transcriptionDiagnostics.lastError
      );

      await appendGatewayEvent(db, conversationId, "Voice transcription unavailable", {
        source: "gateway",
        type: "voice_transcription_unavailable",
        portal: config.portal,
        configId: config.id,
        externalConversationId,
        attachments: attachmentRecords,
      });

      await applyDiscordReactionWithLog(
        db,
        conversationId,
        config,
        externalConversationId,
        body.sourceMessageId,
        "👀",
        "inbound"
      );

      await sendGatewayReply(
        config,
        externalConversationId,
        responseText,
        "⚠️",
        {
          source: "gateway",
          portal: config.portal,
          configId: config.id,
          channelName,
          userName,
          mode: "voice",
          fallback: "missing_transcript",
        }
      );

      await applyDiscordReactionWithLog(
        db,
        conversationId,
        config,
        externalConversationId,
        body.sourceMessageId,
        "⚠️",
        "error"
      );

      res.json(createApiResponse({
        conversationId,
        replyText: responseText,
        result: { response: responseText, fallback: true, reason: "missing_transcript" },
        portal: config.portal,
        configId: config.id,
        reaction: "⚠️",
      }));
      return;
    }

    const prefixedMessage = userName
      ? `[${config.portal} / ${userName}] ${messageWithAttachmentHints}`
      : `[${config.portal}] ${messageWithAttachmentHints}`;

    await applyDiscordReactionWithLog(
      db,
      conversationId,
      config,
      externalConversationId,
      body.sourceMessageId,
      "👀",
      "inbound"
    );

    let result: unknown;
    let responseText = "";
    let processingFailed = false;
    let processingErrorMessage: string | undefined;
    try {
      const runResult = await runAgentWithRepairRetry(
        createAgent ?? (() => agent),
        prefixedMessage,
        (errorMessage) => [
          "The previous gateway run failed with a runtime error.",
          `Error: ${errorMessage}`,
          "Start over from scratch with a fresh solution path.",
          prefixedMessage,
        ].join("\n"),
        async (runAgent) => {
          await runAgent.loadConversation(conversationId);
        }
      );
      responseText = runResult.result.response;
      result = runResult.result;
    } catch (processingError) {
      processingFailed = true;
      processingErrorMessage = processingError instanceof Error ? processingError.message : String(processingError);
      responseText = buildGatewayProcessingFallbackReply(
        processingErrorMessage,
        attachmentPaths,
        hasAudioAttachments,
        hasVoiceTranscript,
        body.voiceTranscript
      );
      result = {
        response: responseText,
        error: processingErrorMessage,
        fallback: true,
      };
      await appendGatewayEvent(db, conversationId, "Gateway processing failed", {
        source: "gateway",
        type: "processing_error",
        portal: config.portal,
        configId: config.id,
        externalConversationId,
        error: processingErrorMessage,
      });
      await applyDiscordReactionWithLog(
        db,
        conversationId,
        config,
        externalConversationId,
        body.sourceMessageId,
        "⚠️",
        "error"
      );
    }

    const reaction = processingFailed
      ? "⚠️"
      : body.agentEmoji?.trim() || pickAgentReaction(responseText);
    await appendGatewayEvent(db, conversationId, "Gateway inbound received", {
      source: "gateway",
      type: "inbound",
      portal: config.portal,
      configId: config.id,
      agentInputMode: useTranscriptOnlyForAgent ? "voice_transcript_only" : "default",
      mode: body.mode ?? (attachmentRecords.length > 0 ? "file" : body.voiceTranscript ? "voice" : "text"),
      channelName,
      externalConversationId,
      userName,
      voice: body.voiceTranscript
        ? {
            transcript: body.voiceTranscript,
            language: body.voiceLanguage,
            durationMs: body.voiceDurationMs,
          }
        : undefined,
      attachments: attachmentRecords,
      reactions: body.reactions,
      agentEmoji: body.agentEmoji,
    });
    await appendGatewayEvent(db, conversationId, `Agent reaction: ${reaction}`, {
      source: "gateway",
      type: "reaction",
      emoji: reaction,
      portal: config.portal,
      configId: config.id,
    });

    try {
      await sendGatewayReply(
        config,
        externalConversationId,
        responseText,
        reaction,
        {
          source: "gateway",
          portal: config.portal,
          configId: config.id,
          channelName,
          userName,
        }
      );
      await appendGatewayEvent(db, conversationId, "Outbound reply sent", {
        source: "gateway",
        type: "outbound_reply",
        portal: config.portal,
        configId: config.id,
        externalConversationId,
      });
      await applyDiscordReactionWithLog(
        db,
        conversationId,
        config,
        externalConversationId,
        body.sourceMessageId,
        "✅",
        "processed"
      );
    } catch (replyError) {
      const replyErrorMessage = replyError instanceof Error ? replyError.message : String(replyError);
      await appendGatewayEvent(db, conversationId, "Outbound reply failed", {
        source: "gateway",
        type: "outbound_error",
        portal: config.portal,
        configId: config.id,
        externalConversationId,
        error: replyErrorMessage,
      });
      await applyDiscordReactionWithLog(
        db,
        conversationId,
        config,
        externalConversationId,
        body.sourceMessageId,
        "⚠️",
        "error"
      );
      console.error("Gateway outbound reply failed", {
        portal: config.portal,
        configId: config.id,
        externalConversationId,
        error: replyErrorMessage,
      });
    }

    res.json(createApiResponse({
      conversationId,
      replyText: responseText,
      result,
      portal: config.portal,
      configId: config.id,
      reaction,
    }));
  } catch (error) {
    next(error);
  } finally {
    if (runId) {
      const agentRegistry = req.app.locals["agentRegistry"] as { unregister: (id: string) => void };
      agentRegistry.unregister(runId);
    }
  }
});

gatewayRouter.post("/:portal/:id/webhook", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const createAgent = req.app.locals["createAgent"] as (() => Agent) | undefined;
    const agent = createAgent ? createAgent() : (req.app.locals["agent"] as Agent);
    const agentRegistry = req.app.locals["agentRegistry"] as {
      register: (entry: { source: "chat_http" | "chat_ws" | "task_run" | "gateway_inbound"; conversationId?: number; taskId?: number; socketId?: string; label?: string }) => string;
      unregister: (id: string) => void;
    };

    const portal = normalizePortal(String(req.params["portal"] ?? "custom"));
    const configId = String(req.params["id"] ?? "").trim();
    const configs = parseGatewayConfigs(await db.getSetting(SETTINGS_KEY));
    const config = configs.find((entry) => entry.id === configId && entry.portal === portal && entry.enabled);
    if (!config) {
      res.status(404).json(createApiError("Gateway config not found or disabled"));
      return;
    }

    if (portal === "discord" && shouldVerifyDiscordRequest(req.body, req.headers)) {
      const signature = String(req.headers["x-signature-ed25519"] ?? "").trim();
      const timestamp = String(req.headers["x-signature-timestamp"] ?? "").trim();
      const rawBody = String((req as typeof req & { rawBody?: string }).rawBody ?? "");
      if (!signature || !timestamp || !rawBody) {
        await db.addLog({
          level: "warn",
          message: "[Gateway discord] Discord signature headers missing",
          context: JSON.stringify({
            portal,
            configId,
            hasSignature: Boolean(signature),
            hasTimestamp: Boolean(timestamp),
            hasRawBody: Boolean(rawBody),
          }),
        }).catch(() => {
          // Ignore logging failures during request verification.
        });
        res.status(401).json(createApiError("Missing Discord signature headers or raw body"));
        return;
      }
      const signatureValid = verifyDiscordRequestSignature(config, rawBody, timestamp, signature);
      await db.addLog({
        level: signatureValid ? "info" : "warn",
        message: signatureValid ? "[Gateway discord] Discord signature verified" : "[Gateway discord] Discord signature invalid",
        context: JSON.stringify({
          portal,
          configId,
          appId: config.appId,
          hasPublicKey: Boolean(resolveDiscordPublicKey(config)),
          timestamp,
        }),
      }).catch(() => {
        // Ignore logging failures during request verification.
      });
      if (!signatureValid) {
        res.status(401).json(createApiError("Invalid Discord request signature"));
        return;
      }
    }

    const interactionType = Number((req.body as Record<string, unknown> | undefined)?.["type"] ?? 0);
    if (portal === "discord" && interactionType === 1) {
      res.json({ type: 1 });
      return;
    }

    const discordInteraction = portal === "discord" ? parseDiscordInteractionPayload(req.body) : undefined;
    if (portal === "discord" && [2, 3].includes(interactionType) && !discordInteraction) {
      await db.addLog({
        level: "warn",
        message: "[Gateway discord] Interaction payload could not be parsed",
        context: JSON.stringify({
          portal,
          configId,
          interactionType,
          hasApplicationId: Boolean((req.body as Record<string, unknown> | undefined)?.["application_id"]),
          hasToken: Boolean((req.body as Record<string, unknown> | undefined)?.["token"]),
          hasChannelId: Boolean((req.body as Record<string, unknown> | undefined)?.["channel_id"]),
        }),
      }).catch(() => {
        // Ignore logging failures while responding to interaction.
      });

      res.json({
        type: 4,
        data: {
          content: "Interaction empfangen, aber das Payload-Format wurde nicht erkannt.",
        },
      });
      return;
    }

    if (discordInteraction) {
      res.json({ type: 5 });

      void (async () => {
        let runId: string | undefined;
        try {
          const interactionSessionCommand = parseNewSessionCommand(discordInteraction.message, { allowBare: true });
          const conversationId = await getOrCreateGatewayConversation(
            db,
            config,
            discordInteraction.externalConversationId,
            undefined,
            interactionSessionCommand.requestedNewSession
          );

          if (interactionSessionCommand.commandOnly) {
            const resetReply = buildNewSessionReply();
            await appendGatewayEvent(db, conversationId, "Gateway session reset", {
              source: "gateway",
              type: "session_reset",
              portal: config.portal,
              configId: config.id,
              externalConversationId: discordInteraction.externalConversationId,
              channelName: resolveGatewayChannelName(config, discordInteraction.channelName),
              userName: resolveGatewayUserName(config, discordInteraction.userName),
              mode: "interaction",
              applicationId: discordInteraction.applicationId,
            });
            await updateDiscordInteractionResponse(discordInteraction.applicationId, discordInteraction.interactionToken, resetReply);
            return;
          }

          await agent.loadConversation(conversationId);
          const label = `${config.portal}:${config.name}`;
          runId = agentRegistry.register({
            source: "gateway_inbound",
            conversationId,
            label,
          });

          const interactionUserName = resolveGatewayUserName(config, discordInteraction.userName);
          const interactionMessage = interactionSessionCommand.requestedNewSession
            ? interactionSessionCommand.forwardedMessage
            : discordInteraction.message;
          const incomingMessage = interactionUserName
            ? `[${config.portal} / ${interactionUserName}] ${interactionMessage}`
            : `[${config.portal}] ${interactionMessage}`;
          const result = await runAgentWithRepairRetry(
            createAgent ?? (() => agent),
            incomingMessage,
            (errorMessage) => [
              "The previous Discord interaction run failed with a runtime error.",
              `Error: ${errorMessage}`,
              "Start over from scratch with a fresh solution path.",
              incomingMessage,
            ].join("\n"),
            async (runAgent) => {
              await runAgent.loadConversation(conversationId);
            }
          );
          const responseText = result.result.response;
          const reaction = pickAgentReaction(responseText);

          await appendGatewayEvent(db, conversationId, "Gateway webhook received", {
            source: "gateway",
            type: "inbound",
            portal: config.portal,
            configId: config.id,
            channelName: resolveGatewayChannelName(config, discordInteraction.channelName),
            externalConversationId: discordInteraction.externalConversationId,
            userName: interactionUserName,
            mode: "interaction",
            applicationId: discordInteraction.applicationId,
          });
          await appendGatewayEvent(db, conversationId, `Agent reaction: ${reaction}`, {
            source: "gateway",
            type: "reaction",
            emoji: reaction,
            portal: config.portal,
            configId: config.id,
          });

          await updateDiscordInteractionResponse(discordInteraction.applicationId, discordInteraction.interactionToken, responseText);
          await appendGatewayEvent(db, conversationId, "Outbound reply sent", {
            source: "gateway",
            type: "outbound_reply",
            portal: config.portal,
            configId: config.id,
            externalConversationId: discordInteraction.externalConversationId,
            transport: "interaction",
          });
        } catch (replyError) {
          const replyErrorMessage = replyError instanceof Error ? replyError.message : String(replyError);
          await updateDiscordInteractionResponse(discordInteraction.applicationId, discordInteraction.interactionToken, `Fehler: ${replyErrorMessage}`).catch(() => {
            // Ignore follow-up update failures after the primary error is captured.
          });
          console.error("Discord interaction processing failed", {
            portal,
            configId,
            externalConversationId: discordInteraction.externalConversationId,
            error: replyErrorMessage,
          });
        } finally {
          if (runId) {
            agentRegistry.unregister(runId);
          }
        }
      })();

      return;
    }

    const telegram = parseTelegramUpdate(req.body);
    const discord = parseDiscordBridgePayload(req.body);
    const normalized = telegram ?? discord;
    if (!normalized) {
      res.status(400).json(createApiError("Unsupported webhook payload"));
      return;
    }

    const webhookSessionCommand = config.portal === "discord"
      ? parseNewSessionCommand(normalized.message)
      : { requestedNewSession: false, forwardedMessage: normalized.message, commandOnly: false };

    const conversationId = await getOrCreateGatewayConversation(
      db,
      config,
      normalized.externalConversationId,
      undefined,
      webhookSessionCommand.requestedNewSession
    );
    await agent.loadConversation(conversationId);
    const label = `${config.portal}:${config.name}`;
    const runId = agentRegistry.register({
      source: "gateway_inbound",
      conversationId,
      label,
    });

    try {
      if (webhookSessionCommand.commandOnly) {
        const resetReply = buildNewSessionReply();
        await appendGatewayEvent(db, conversationId, "Gateway session reset", {
          source: "gateway",
          type: "session_reset",
          portal: config.portal,
          configId: config.id,
          channelName: resolveGatewayChannelName(config, normalized.channelName),
          externalConversationId: normalized.externalConversationId,
          userName: resolveGatewayUserName(config, normalized.userName),
          mode: "webhook",
        });

        await sendGatewayReply(
          config,
          normalized.externalConversationId,
          resetReply,
          "♻️",
          {
            source: "gateway",
            portal: config.portal,
            configId: config.id,
            channelName: resolveGatewayChannelName(config, normalized.channelName),
            userName: resolveGatewayUserName(config, normalized.userName),
            command: "new_session",
          }
        );

        await appendGatewayEvent(db, conversationId, "Outbound reply sent", {
          source: "gateway",
          type: "outbound_reply",
          portal: config.portal,
          configId: config.id,
          externalConversationId: normalized.externalConversationId,
          reaction: "♻️",
        });

        res.json(createApiResponse({ conversationId, replyText: resetReply, result: { response: resetReply, command: "new_session", reset: true }, portal: config.portal, configId: config.id, reaction: "♻️" }));
        return;
      }

      const webhookMessage = webhookSessionCommand.requestedNewSession
        ? webhookSessionCommand.forwardedMessage
        : normalized.message;
      const incomingMessage = resolveGatewayUserName(config, normalized.userName)
        ? `[${config.portal} / ${resolveGatewayUserName(config, normalized.userName)}] ${webhookMessage}`
        : `[${config.portal}] ${webhookMessage}`;
      const result = await runAgentWithRepairRetry(
        createAgent ?? (() => agent),
        incomingMessage,
        (errorMessage) => [
          "The previous gateway webhook run failed with a runtime error.",
          `Error: ${errorMessage}`,
          "Start over from scratch with a fresh solution path.",
          incomingMessage,
        ].join("\n"),
        async (runAgent) => {
          await runAgent.loadConversation(conversationId);
        }
      );
      const responseText = result.result.response;
      const reaction = pickAgentReaction(responseText);
      await appendGatewayEvent(db, conversationId, "Gateway webhook received", {
        source: "gateway",
        type: "inbound",
        portal: config.portal,
        configId: config.id,
        channelName: resolveGatewayChannelName(config, normalized.channelName),
        externalConversationId: normalized.externalConversationId,
        userName: resolveGatewayUserName(config, normalized.userName),
        mode: "webhook",
      });
      await appendGatewayEvent(db, conversationId, `Agent reaction: ${reaction}`, {
        source: "gateway",
        type: "reaction",
        emoji: reaction,
        portal: config.portal,
        configId: config.id,
      });

      try {
        await sendGatewayReply(
          config,
          normalized.externalConversationId,
          responseText,
          reaction,
          {
            source: "gateway",
            portal: config.portal,
            configId: config.id,
            channelName: resolveGatewayChannelName(config, normalized.channelName),
            userName: resolveGatewayUserName(config, normalized.userName),
          }
        );
        await appendGatewayEvent(db, conversationId, "Outbound reply sent", {
          source: "gateway",
          type: "outbound_reply",
          portal: config.portal,
          configId: config.id,
          externalConversationId: normalized.externalConversationId,
        });
      } catch (replyError) {
        const replyErrorMessage = replyError instanceof Error ? replyError.message : String(replyError);
        await appendGatewayEvent(db, conversationId, "Outbound reply failed", {
          source: "gateway",
          type: "outbound_error",
          portal: config.portal,
          configId: config.id,
          externalConversationId: normalized.externalConversationId,
          error: replyErrorMessage,
        });
        console.error("Gateway outbound reply failed", {
          portal: config.portal,
          configId: config.id,
          externalConversationId: normalized.externalConversationId,
          error: replyErrorMessage,
        });
      }

      res.json(createApiResponse({ conversationId, replyText: responseText, result, portal: config.portal, configId: config.id, reaction }));
    } finally {
      agentRegistry.unregister(runId);
    }
  } catch (error) {
    next(error);
  }
});
