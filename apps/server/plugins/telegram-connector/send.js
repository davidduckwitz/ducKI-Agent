/**
 * Telegram outbound send logic - chunking, multipart attachments. Structurally mirrors
 * apps/server/plugins/discord-connector/send.js (see docs/gateway-connector-plugin-plan.md
 * section 12 - a future connector reuses the same shape, no core changes needed).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep, basename, extname } from "node:path";

const SHARED_ROOT = resolve(process.env["SHARED_WORKSPACE_PATH"] ?? "./shared-workspace");

// Telegram text messages are limited to 4096 UTF-16 code units; keep a small buffer.
export const TELEGRAM_MESSAGE_MAX_CHARS = 4000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Telegram Bot API document upload limit
const MAX_ATTACHMENTS = 10;

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function splitForTelegram(content, maxChars = TELEGRAM_MESSAGE_MAX_CHARS) {
  const text = String(content ?? "").trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut < Math.floor(maxChars * 0.6)) cut = rest.lastIndexOf(" ", maxChars);
    if (cut < Math.floor(maxChars * 0.4)) cut = maxChars;
    const part = rest.slice(0, cut).trim();
    if (part.length > 0) chunks.push(part);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** Same traversal guard as discord-connector/send.js - reimplemented locally so this plugin
 *  has no dependency on a workspace package (plugin modules are loaded standalone). */
function resolveWithinSharedRoot(relativePath) {
  const withoutPrefix = String(relativePath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/^shared-workspace\/+/i, "")
    .trim();
  if (!withoutPrefix || withoutPrefix.includes("..")) {
    throw new Error(`Invalid attachment path: ${relativePath}`);
  }
  const absolute = resolve(SHARED_ROOT, withoutPrefix);
  if (absolute !== SHARED_ROOT && !absolute.startsWith(SHARED_ROOT + sep)) {
    throw new Error(`Attachment path escapes shared workspace: ${relativePath}`);
  }
  return absolute;
}

function loadOneAttachment(attachment) {
  if (attachment.data) {
    return { name: attachment.name || "attachment", data: attachment.data, type: attachment.mimeType || "application/octet-stream" };
  }
  if (attachment.path) {
    const abs = resolveWithinSharedRoot(attachment.path);
    if (!existsSync(abs)) throw new Error(`Attachment not found in shared workspace: ${attachment.path}`);
    const size = statSync(abs).size;
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment too large: ${attachment.path} (${Math.round(size / 1024)}KB, max ${Math.round(MAX_ATTACHMENT_BYTES / 1024)}KB)`);
    }
    const ext = extname(abs).toLowerCase();
    return { name: basename(abs), data: readFileSync(abs), type: attachment.mimeType || MIME_BY_EXT[ext] || "application/octet-stream", isImage: IMAGE_EXT.has(ext) };
  }
  throw new Error(`Attachment '${attachment.name ?? "?"}' has neither 'path' nor 'data' - outbound send only supports shared-workspace paths or in-memory buffers`);
}

export function loadAttachments(attachments) {
  const list = attachments ?? [];
  if (list.length === 0) return [];
  if (list.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments (${list.length}); Telegram allows at most ${MAX_ATTACHMENTS} per message here.`);
  }
  return list.map(loadOneAttachment);
}

async function readErrorBody(response) {
  try {
    const body = await response.json();
    return body?.description ? String(body.description).slice(0, 300) : "";
  } catch {
    return "";
  }
}

async function callTelegram(botToken, method, form) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/${method}`;
  const response = await fetch(url, { method: "POST", body: form });
  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new Error(`Telegram ${method} failed: HTTP ${response.status}${body ? ` - ${body}` : ""}`);
  }
  return response.json();
}

async function sendText(botToken, chatId, text) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("text", text);
  await callTelegram(botToken, "sendMessage", form);
}

async function sendOneFile(botToken, chatId, file, caption) {
  const method = file.isImage ? "sendPhoto" : "sendDocument";
  const field = file.isImage ? "photo" : "document";
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) form.append("caption", caption.slice(0, TELEGRAM_MESSAGE_MAX_CHARS));
  form.append(field, new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
  await callTelegram(botToken, method, form);
}

/** Sends a (possibly multi-chunk) Telegram message, with attachments carrying the first chunk
 *  as their caption (Telegram has no separate "message + files" combined call like Discord). */
export async function sendTelegramMessage(botToken, chatId, text, attachments) {
  const chunks = splitForTelegram(text);
  const files = loadAttachments(attachments);
  if (chunks.length === 0 && files.length === 0) return;

  if (files.length === 0) {
    for (const chunk of chunks) await sendText(botToken, chatId, chunk);
    return;
  }

  const [firstFile, ...restFiles] = files;
  await sendOneFile(botToken, chatId, firstFile, chunks[0]);
  for (const file of restFiles) await sendOneFile(botToken, chatId, file, undefined);
  for (const chunk of chunks.slice(1)) await sendText(botToken, chatId, chunk);
}

/** Capability metadata surfaced to the agent via `gateway` tool's list_configs (plan 10.3). */
export const TELEGRAM_CAPABILITIES = {
  maxMessageLength: TELEGRAM_MESSAGE_MAX_CHARS,
  supportsAttachments: true,
  supportsReactions: false,
  targetFieldName: "channelId",
  exampleTarget: "123456789",
};
