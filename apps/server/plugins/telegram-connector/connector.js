/**
 * Telegram connector plugin: Bot API long-polling client (getUpdates) + ConnectorAdapter wiring.
 * Structurally mirrors apps/server/plugins/discord-connector/connector.js, using long-polling
 * instead of a WebSocket - Telegram's Bot API supports both getUpdates (pull) and webhooks
 * (push); long-polling was chosen so this connector needs no public HTTPS URL, matching
 * Discord's self-contained "just needs a token" setup story (see docs/gateway-connector-plugin-plan.md
 * section 12: a future connector must normalize its own addressing scheme onto channelId and
 * needs no other core change - this file is the proof).
 */

import { sendTelegramMessage, TELEGRAM_CAPABILITIES } from "./send.js";

const POLL_TIMEOUT_SECONDS = 30;
// Slightly longer than the long-poll timeout itself, so a slow-but-alive connection isn't
// mistaken for a hang.
const FETCH_TIMEOUT_MS = (POLL_TIMEOUT_SECONDS + 10) * 1000;

class TelegramPoller {
  constructor(options) {
    this.options = options;
    this.stopped = false;
    this.offset = 0;
    this.abortController = null;
    this.retryTimer = null;
    this.botUserId = "";
  }

  async start() {
    this.stopped = false;
    try {
      const me = await this.call("getMe");
      this.botUserId = String(me?.result?.id ?? "");
      this.options.onReady?.(this.botUserId, me?.result?.username);
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    void this.pollLoop();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.abortController?.abort();
  }

  async call(method, params = {}) {
    this.abortController = new AbortController();
    const timeout = setTimeout(() => this.abortController?.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(this.options.botToken)}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: this.abortController.signal,
      });
      const body = await response.json();
      if (!response.ok || body?.ok === false) {
        throw new Error(`Telegram ${method} failed: HTTP ${response.status}${body?.description ? ` - ${body.description}` : ""}`);
      }
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }

  async pollLoop() {
    while (!this.stopped) {
      try {
        const result = await this.call("getUpdates", {
          offset: this.offset,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ["message", "edited_message"],
        });
        const updates = Array.isArray(result?.result) ? result.result : [];
        for (const update of updates) {
          this.offset = Math.max(this.offset, Number(update.update_id ?? 0) + 1);
          this.handleUpdate(update);
        }
      } catch (error) {
        if (this.stopped) return;
        const message = error instanceof Error ? error.message : String(error);
        // AbortError from our own timeout is expected on an idle long-poll window - just retry.
        if (!message.includes("aborted") && !message.includes("AbortError")) {
          this.options.onError?.(error instanceof Error ? error : new Error(message));
        }
        await new Promise((resolve) => {
          this.retryTimer = setTimeout(resolve, 3000 + Math.random() * 2000);
        });
      }
    }
  }

  handleUpdate(update) {
    const message = update.message ?? update.edited_message;
    if (!message) return;
    const from = message.from;
    if (from?.is_bot === true) return;

    const text = String(message.text ?? message.caption ?? "").trim();
    const attachments = this.extractAttachmentRefs(message);
    if (!text && attachments.length === 0) return;

    const chat = message.chat;
    const chatId = String(chat?.id ?? "").trim();
    if (!chatId) return;
    const messageId = String(message.message_id ?? "").trim();

    if (this.options.allowedChatId && chatId !== this.options.allowedChatId) return;
    const authorId = String(from?.id ?? "").trim();
    if (this.options.allowedUserId && authorId !== this.options.allowedUserId) return;

    const authorName = [from?.first_name, from?.last_name].filter(Boolean).join(" ").trim() || from?.username || "";
    const channelName = chat?.title ?? chat?.username ?? String(chatId);

    void this.resolveAttachments(attachments).then((resolved) => {
      void this.options.onMessage({
        messageId,
        chatId,
        channelName,
        authorId,
        authorName,
        content: text,
        attachments: resolved,
        botUserId: this.botUserId,
      });
    });
  }

  /** Telegram only gives file_id in the update; the actual download URL needs a getFile call. */
  extractAttachmentRefs(message) {
    const refs = [];
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1];
      refs.push({ fileId: largest.file_id, filename: "photo.jpg", mimeType: "image/jpeg", size: largest.file_size });
    }
    if (message.document) {
      refs.push({
        fileId: message.document.file_id,
        filename: message.document.file_name ?? "document",
        mimeType: message.document.mime_type,
        size: message.document.file_size,
      });
    }
    if (message.voice) {
      refs.push({ fileId: message.voice.file_id, filename: "voice.ogg", mimeType: message.voice.mime_type ?? "audio/ogg", size: message.voice.file_size });
    }
    return refs;
  }

  async resolveAttachments(refs) {
    const resolved = [];
    for (const ref of refs) {
      try {
        const result = await this.call("getFile", { file_id: ref.fileId });
        const filePath = result?.result?.file_path;
        if (!filePath) continue;
        resolved.push({
          id: ref.fileId,
          filename: ref.filename,
          url: `https://api.telegram.org/file/bot${encodeURIComponent(this.options.botToken)}/${filePath}`,
          mimeType: ref.mimeType,
          size: ref.size,
        });
      } catch {
        // Skip attachments whose download URL can't be resolved rather than dropping the whole message.
      }
    }
    return resolved;
  }
}

/** Factory required by the connector-registry (provides.connector.module export contract). */
export function createConnector(manifest) {
  const portal = manifest.portal;
  const status = { configured: false, active: false, updatedAt: new Date().toISOString() };
  let poller;
  let ctx;

  return {
    getStatus() {
      return { ...status };
    },

    getCapabilities() {
      return TELEGRAM_CAPABILITIES;
    },

    async connect(connectorCtx) {
      ctx = connectorCtx;
      const botToken = String(ctx.secrets["authToken"] ?? process.env["TELEGRAM_BOT_TOKEN"] ?? "").trim();
      if (!botToken) {
        status.configured = false;
        status.lastError = "Missing Telegram bot token (plugin setting authToken or env TELEGRAM_BOT_TOKEN)";
        status.updatedAt = new Date().toISOString();
        ctx.logger.warn("Telegram connector not started: no bot token configured");
        return;
      }
      status.configured = true;

      const allowedChatId = String(ctx.settings["allowedChatId"] ?? "").trim() || undefined;
      const allowedUserId = String(ctx.settings["allowedUserId"] ?? "").trim() || undefined;

      poller = new TelegramPoller({
        botToken,
        allowedChatId,
        allowedUserId,
        onReady: (botUserId, username) => {
          status.active = true;
          status.connectedAt = new Date().toISOString();
          status.lastError = undefined;
          status.updatedAt = new Date().toISOString();
          ctx.logger.info("Telegram long-polling connected", { botUserId, username, allowedChatId, allowedUserId });
        },
        onError: (err) => {
          status.active = false;
          status.lastError = err.message;
          status.updatedAt = new Date().toISOString();
          ctx.logger.warn("Telegram polling error", { message: err.message });
        },
        onMessage: async (msg) => {
          try {
            await ctx.onInboundMessage({
              portal,
              externalConversationId: msg.chatId,
              sourceMessageId: msg.messageId,
              channelName: msg.channelName,
              authorId: msg.authorId,
              userName: msg.authorName,
              content: msg.content,
              attachments: msg.attachments,
            });
          } catch (error) {
            ctx.logger.warn("Telegram inbound dispatch failed", { error: error instanceof Error ? error.message : String(error) });
          }
        },
      });

      await poller.start();
    },

    async disconnect() {
      poller?.stop();
      poller = undefined;
      status.active = false;
      status.updatedAt = new Date().toISOString();
    },

    async send(target, message) {
      if (!ctx) throw new Error("Telegram connector is not connected (no bot token configured)");
      const botToken = String(ctx.secrets["authToken"] ?? process.env["TELEGRAM_BOT_TOKEN"] ?? "").trim();
      if (!botToken) throw new Error("Telegram connector has no authToken (bot token) configured for sending");
      await sendTelegramMessage(botToken, target.channelId, message.text, message.attachments);
    },
  };
}
