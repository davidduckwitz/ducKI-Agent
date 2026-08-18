/**
 * Discord connector plugin: Discord Gateway v10 WebSocket client + ConnectorAdapter wiring.
 * Moved from apps/server/src/lib/discord-gateway-ws.ts (see
 * docs/gateway-connector-plugin-plan.md section 6, migration step 1).
 *
 * Required bot intents (must also be enabled in Discord Developer Portal):
 *   GUILDS (1 << 0), GUILD_MESSAGES (1 << 9), DIRECT_MESSAGES (1 << 12),
 *   MESSAGE_CONTENT (1 << 15 - privileged)
 */

import WebSocket from "ws";
import { sendDiscordMessage, reactToDiscordMessage, DISCORD_CAPABILITIES } from "./send.js";
import { handleDiscordWebhook } from "./webhook.js";

const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

const FATAL_CLOSE_CODES = {
  4004:
    "Authentication failed - the Discord bot token is invalid, expired or was regenerated. " +
    "Check the plugin's authToken setting and copy a fresh token from " +
    "Discord Developer Portal > Your App > Bot > Reset Token. Note: this is the BOT token, not the client secret or application id.",
  4010: "Invalid shard sent in the identify payload.",
  4011: "Sharding required - this bot is in too many guilds for a single connection.",
  4012: "Invalid API version requested by the gateway client.",
  4013: "Invalid intents - the requested intent bits are not valid.",
  4014:
    "Disallowed intents - the bot requests the privileged MESSAGE_CONTENT intent but it is not enabled. " +
    "Enable it under Discord Developer Portal > Your App > Bot > Privileged Gateway Intents " +
    "(MESSAGE CONTENT INTENT, and SERVER MEMBERS INTENT if you need it), then restart.",
};

class DiscordGatewayClient {
  constructor(options) {
    this.options = options;
    this.ws = null;
    this.heartbeatTimer = null;
    this.heartbeatStartTimer = null;
    this.reconnectTimer = null;
    this.sequence = null;
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.botUserId = "";
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.connect(GATEWAY_URL);
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000, "Stopped");
    this.ws = null;
  }

  connect(url) {
    this.ws = new WebSocket(url);

    this.ws.on("message", (raw) => {
      try {
        this.handlePayload(JSON.parse(String(raw)));
      } catch {
        // Ignore malformed frames.
      }
    });

    this.ws.on("close", (code) => {
      this.clearTimers();
      if (this.stopped) return;

      const remedy = FATAL_CLOSE_CODES[code];
      if (remedy) {
        this.stopped = true;
        this.ws = null;
        this.options.onError?.(new Error(`Discord Gateway stopped - close code ${code}: ${remedy}`));
        return;
      }

      const reconnectUrl = this.resumeGatewayUrl ?? GATEWAY_URL;
      this.reconnectTimer = setTimeout(() => {
        if (!this.stopped) this.connect(reconnectUrl);
      }, 5000 + Math.random() * 2500);
    });

    this.ws.on("error", (err) => {
      this.options.onError?.(err);
    });
  }

  handlePayload(payload) {
    if (payload.s !== null && payload.s !== undefined) this.sequence = payload.s;

    switch (payload.op) {
      case 10: {
        this.startHeartbeat(payload.d.heartbeat_interval);
        if (this.sessionId) this.resume();
        else this.identify();
        break;
      }
      case 11:
        break;
      case 1:
        this.sendHeartbeat();
        break;
      case 7:
        this.ws?.close(4000, "Reconnect requested");
        break;
      case 9: {
        const resumable = payload.d === true;
        if (!resumable) {
          this.sessionId = null;
          this.resumeGatewayUrl = null;
        }
        setTimeout(() => {
          if (!this.stopped) resumable ? this.resume() : this.identify();
        }, 1000 + Math.random() * 4000);
        break;
      }
      case 0:
        this.handleDispatch(payload.t ?? "", payload.d);
        break;
    }
  }

  handleDispatch(event, data) {
    if (event === "READY") {
      this.sessionId = data.session_id;
      this.resumeGatewayUrl = data.resume_gateway_url;
      this.botUserId = data.user.id;
      this.options.onReady?.(this.botUserId);
      return;
    }
    if (event === "RESUMED") return;
    if (event === "MESSAGE_CREATE") this.handleMessageCreate(data);
  }

  handleMessageCreate(msg) {
    const author = msg["author"];
    if (author?.["bot"] === true) return;

    const content = String(msg["content"] ?? "").trim();
    const rawAttachments = Array.isArray(msg["attachments"]) ? msg["attachments"] : [];
    const attachments = rawAttachments
      .filter((a) => a["id"] && a["url"])
      .map((a) => ({
        id: String(a["id"]),
        filename: String(a["filename"] ?? "attachment"),
        url: String(a["url"]),
        mimeType: a["content_type"] ? String(a["content_type"]) : undefined,
        size: Number(a["size"] ?? 0),
      }));

    if (!content && attachments.length === 0) return;

    const channelId = String(msg["channel_id"] ?? "").trim();
    if (!channelId) return;
    const messageId = String(msg["id"] ?? "").trim();
    if (!messageId) return;

    const guildId = msg["guild_id"] ? String(msg["guild_id"]).trim() : undefined;
    const isDm = !guildId;
    if (!isDm && this.options.guildId && guildId !== this.options.guildId) return;

    const authorId = String(author?.["id"] ?? "").trim();
    const authorName = String(author?.["global_name"] ?? author?.["username"] ?? "").trim();
    if (this.options.allowedUserId && authorId !== this.options.allowedUserId) return;

    void this.options.onMessage({
      messageId,
      channelId,
      guildId,
      authorId,
      authorName,
      content,
      attachments,
      botUserId: this.botUserId,
    });
  }

  identify() {
    this.send({
      op: 2,
      d: { token: this.options.botToken, intents: DISCORD_INTENTS, properties: { os: "linux", browser: "ducki", device: "ducki" } },
    });
  }

  resume() {
    this.send({ op: 6, d: { token: this.options.botToken, session_id: this.sessionId, seq: this.sequence } });
  }

  startHeartbeat(intervalMs) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatStartTimer) clearTimeout(this.heartbeatStartTimer);
    const jitter = Math.random() * intervalMs;
    this.heartbeatStartTimer = setTimeout(() => {
      this.heartbeatStartTimer = null;
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
    }, jitter);
  }

  sendHeartbeat() {
    this.send({ op: 1, d: this.sequence });
  }

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }

  clearTimers() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.heartbeatStartTimer) { clearTimeout(this.heartbeatStartTimer); this.heartbeatStartTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
}

/** Factory required by the connector-registry (provides.connector.module export contract). */
export function createConnector(manifest) {
  const portal = manifest.portal;
  /** @type {{configured:boolean, active:boolean, connectedAt?:string, lastError?:string, updatedAt:string}} */
  const status = { configured: false, active: false, updatedAt: new Date().toISOString() };
  let client;
  let ctx;

  return {
    getStatus() {
      // "configured" reflects whether a bot token is available (env fallback or plugin setting),
      // independent of connect() having been called yet - the registry reads this BEFORE deciding
      // whether to call connect() at all.
      return { ...status };
    },

    getCapabilities() {
      return DISCORD_CAPABILITIES;
    },

    async connect(connectorCtx) {
      ctx = connectorCtx;
      const botToken = String(ctx.secrets["authToken"] ?? process.env["DISCORD_BOT_TOKEN"] ?? "").trim();
      if (!botToken) {
        status.configured = false;
        status.lastError = "Missing Discord bot token (plugin setting authToken or env DISCORD_BOT_TOKEN)";
        status.updatedAt = new Date().toISOString();
        ctx.logger.warn("Discord connector not started: no bot token configured");
        return;
      }
      status.configured = true;

      const guildId = String(ctx.settings["guildId"] ?? process.env["DISCORD_GUILD_ID"] ?? "").trim() || undefined;
      // "userId" is the allowed-user-id filter (1:1 migration of the old MessagingGatewayConfig.userId field).
      const allowedUserId = String(ctx.settings["userId"] ?? process.env["DISCORD_ALLOWED_USER_ID"] ?? "").trim() || undefined;

      client = new DiscordGatewayClient({
        botToken,
        guildId,
        allowedUserId,
        onReady: (botUserId) => {
          status.active = true;
          status.connectedAt = new Date().toISOString();
          status.lastError = undefined;
          status.updatedAt = new Date().toISOString();
          ctx.logger.info("Discord Gateway connected", { botUserId, guildId, allowedUserId });
        },
        onError: (err) => {
          status.active = false;
          status.lastError = err.message;
          status.updatedAt = new Date().toISOString();
          if (err.message.includes("Discord Gateway stopped")) {
            ctx.logger.error("Discord Gateway stopped and will not reconnect", { message: err.message });
          } else {
            ctx.logger.warn("Discord Gateway error", { message: err.message });
          }
        },
        onMessage: async (msg) => {
          try {
            await ctx.onInboundMessage({
              portal,
              externalConversationId: msg.channelId,
              sourceMessageId: msg.messageId,
              authorId: msg.authorId,
              userName: msg.authorName,
              content: msg.content,
              attachments: msg.attachments,
            });
          } catch (error) {
            ctx.logger.warn("Discord inbound dispatch failed", { error: error instanceof Error ? error.message : String(error) });
          }
        },
      });

      client.start();
    },

    async disconnect() {
      client?.stop();
      client = undefined;
      status.active = false;
      status.updatedAt = new Date().toISOString();
    },

    async send(target, message) {
      if (!ctx) throw new Error("Discord connector is not connected (no bot token configured)");
      const botToken = String(ctx.secrets["authToken"] ?? process.env["DISCORD_BOT_TOKEN"] ?? "").trim();
      if (botToken) {
        await sendDiscordMessage(botToken, target.channelId, message.text, message.attachments);
        return;
      }
      // Fallback outbound transport (1:1 migration of the old webhookSecret webhook-URL path):
      // no bot token configured, but a generic outbound webhook URL is set instead.
      const webhookUrl = String(ctx.secrets["webhookSecret"] ?? "").trim();
      if (/^https?:\/\//i.test(webhookUrl)) {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ portal, externalConversationId: target.channelId, replyText: message.text }),
        });
        if (!response.ok) throw new Error(`Discord webhook send failed: HTTP ${response.status}`);
        return;
      }
      throw new Error("Discord connector has no authToken (bot token) or webhookSecret (webhook URL) available for sending");
    },

    async reactToMessage(target, messageId, emoji) {
      if (!ctx) return;
      const botToken = String(ctx.secrets["authToken"] ?? process.env["DISCORD_BOT_TOKEN"] ?? "").trim();
      if (!botToken) return;
      await reactToDiscordMessage(botToken, target.channelId, messageId, emoji);
    },

    async handleWebhook(req) {
      if (!ctx) return undefined;
      return handleDiscordWebhook(ctx, req);
    },
  };
}
