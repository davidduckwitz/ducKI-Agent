/**
 * Discord outbound send logic - chunking, multipart attachments, reactions. This is the ONE
 * canonical implementation (previously duplicated + drifted between apps/server/src/routes/
 * gateway.ts and packages/agent/src/workflow/workflow-tools.ts - see
 * docs/gateway-connector-plugin-plan.md section 6, migration step 2).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep, basename, extname } from "node:path";

const SHARED_ROOT = resolve(process.env["SHARED_WORKSPACE_PATH"] ?? "./shared-workspace");

// Discord message content is limited to 2000 characters; keep a buffer for formatting/trimming.
export const DISCORD_MESSAGE_MAX_CHARS = 1900;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // conservative Discord free-tier per-file limit
const MAX_ATTACHMENTS = 10; // Discord's per-message attachment limit

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

export function splitForDiscord(content, maxChars = DISCORD_MESSAGE_MAX_CHARS) {
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

/** Same traversal guard as @ducki/shared's resolveWithinRoot, reimplemented locally so this
 *  plugin has no dependency on a workspace package (plugin modules are loaded standalone). */
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
    return { name: basename(abs), data: readFileSync(abs), type: attachment.mimeType || MIME_BY_EXT[ext] || "application/octet-stream" };
  }
  throw new Error(`Attachment '${attachment.name ?? "?"}' has neither 'path' nor 'data' - outbound send only supports shared-workspace paths or in-memory buffers`);
}

export function loadAttachments(attachments) {
  const list = attachments ?? [];
  if (list.length === 0) return [];
  if (list.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments (${list.length}); Discord allows at most ${MAX_ATTACHMENTS} per message.`);
  }
  return list.map(loadOneAttachment);
}

async function readErrorBody(response) {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

async function postOne(url, botToken, content, files) {
  let response;
  if (files.length === 0) {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } else {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content }));
    files.forEach((file, index) => {
      form.append(`files[${index}]`, new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
    });
    response = await fetch(url, { method: "POST", headers: { Authorization: `Bot ${botToken}` }, body: form });
  }
  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new Error(`Discord send failed: HTTP ${response.status}${body ? ` - ${body}` : ""}`);
  }
}

/** Sends a (possibly multi-chunk) Discord channel message, with attachments on the first chunk. */
export async function sendDiscordMessage(botToken, channelId, text, attachments) {
  const chunks = splitForDiscord(text);
  const files = loadAttachments(attachments);
  if (chunks.length === 0 && files.length === 0) return;

  const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`;
  if (chunks.length === 0) {
    await postOne(url, botToken, "", files);
    return;
  }
  await postOne(url, botToken, chunks[0] ?? "", files);
  for (const chunk of chunks.slice(1)) {
    await postOne(url, botToken, chunk, []);
  }
}

function encodeReactionEmoji(emoji) {
  const trimmed = String(emoji ?? "").trim();
  const custom = trimmed.match(/^<a?:([^:>]+):(\d+)>$/);
  if (custom) return encodeURIComponent(`${custom[1]}:${custom[2]}`);
  return encodeURIComponent(trimmed);
}

export async function reactToDiscordMessage(botToken, channelId, messageId, emoji) {
  const encoded = encodeReactionEmoji(emoji);
  const response = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encoded}/@me`,
    { method: "PUT", headers: { Authorization: `Bot ${botToken}` } }
  );
  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new Error(`Discord reaction failed: HTTP ${response.status}${body ? ` - ${body}` : ""}`);
  }
}

/** Capability metadata surfaced to the agent via `gateway` tool's list_configs (plan 10.3). */
export const DISCORD_CAPABILITIES = {
  maxMessageLength: DISCORD_MESSAGE_MAX_CHARS,
  supportsAttachments: true,
  supportsReactions: true,
  targetFieldName: "channelId",
  exampleTarget: "123456789012345678",
};
