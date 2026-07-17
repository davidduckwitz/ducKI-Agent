/**
 * Discord Gateway WebSocket client.
 *
 * Connects to the Discord Gateway to receive real-time events (MESSAGE_CREATE, etc.)
 * so that users can reply in Discord channels with regular messages — not only via
 * slash-command interactions.
 *
 * Required bot intents (must also be enabled in Discord Developer Portal):
 *   GUILDS (1 << 0), GUILD_MESSAGES (1 << 9), MESSAGE_CONTENT (1 << 15 — privileged)
 */

import WebSocket from "ws";

// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT (privileged)
const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

/** Fired for each regular Discord message that is not from a bot. */
export interface DiscordIncomingMessage {
  messageId: string;
  channelId: string;
  channelName?: string;
  guildId?: string;
  authorId: string;
  authorName: string;
  content: string;
  botUserId: string;
  attachments: DiscordAttachment[];
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  url: string;
  proxyUrl: string;
  contentType?: string;
  size: number;
}

export interface DiscordGatewayClientOptions {
  botToken: string;
  /** Optional: only forward messages from this guild. */
  guildId?: string;
  /** Optional: only forward messages from this Discord user id (filters DMs and guild messages). */
  allowedUserId?: string;
  onMessage: (msg: DiscordIncomingMessage) => void | Promise<void>;
  onReady?: (botUserId: string) => void;
  onError?: (err: Error) => void;
}

interface GatewayPayload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

export class DiscordGatewayClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private botUserId = "";
  private stopped = false;

  constructor(private readonly options: DiscordGatewayClientOptions) {}

  start(): void {
    this.stopped = false;
    this.connect(GATEWAY_URL);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000, "Stopped");
    this.ws = null;
  }

  private connect(url: string): void {
    this.ws = new WebSocket(url);

    this.ws.on("message", (raw) => {
      try {
        const payload = JSON.parse(String(raw)) as GatewayPayload;
        this.handlePayload(payload);
      } catch {
        // Ignore malformed frames.
      }
    });

    this.ws.on("close", (code) => {
      this.clearTimers();
      if (this.stopped) return;

      // Fatal close codes — do not reconnect.
      const fatal = [4004, 4010, 4011, 4012, 4013, 4014];
      if (fatal.includes(code)) {
        this.options.onError?.(new Error(`Discord Gateway closed with fatal code ${code}`));
        return;
      }

      // Attempt to RESUME if we have a session, otherwise fresh connect.
      const reconnectUrl = this.resumeGatewayUrl ?? GATEWAY_URL;
      this.reconnectTimer = setTimeout(() => {
        if (!this.stopped) this.connect(reconnectUrl);
      }, 5000 + Math.random() * 2500);
    });

    this.ws.on("error", (err) => {
      this.options.onError?.(err);
    });
  }

  private handlePayload(payload: GatewayPayload): void {
    if (payload.s !== null) this.sequence = payload.s;

    switch (payload.op) {
      case 10: { // HELLO
        const d = payload.d as { heartbeat_interval: number };
        this.startHeartbeat(d.heartbeat_interval);
        if (this.sessionId) {
          this.resume();
        } else {
          this.identify();
        }
        break;
      }
      case 11: // HEARTBEAT_ACK — no-op
        break;
      case 1: // HEARTBEAT request
        this.sendHeartbeat();
        break;
      case 7: // RECONNECT
        this.ws?.close(4000, "Reconnect requested");
        break;
      case 9: { // INVALID_SESSION
        // If resumable (d = true) wait briefly and try again; otherwise re-identify.
        const resumable = payload.d === true;
        if (!resumable) {
          this.sessionId = null;
          this.resumeGatewayUrl = null;
        }
        setTimeout(() => {
          if (!this.stopped) {
            resumable ? this.resume() : this.identify();
          }
        }, 1000 + Math.random() * 4000);
        break;
      }
      case 0: // DISPATCH
        this.handleDispatch(payload.t ?? "", payload.d);
        break;
    }
  }

  private handleDispatch(event: string, data: unknown): void {
    if (event === "READY") {
      const d = data as { session_id: string; resume_gateway_url: string; user: { id: string } };
      this.sessionId = d.session_id;
      this.resumeGatewayUrl = d.resume_gateway_url;
      this.botUserId = d.user.id;
      this.options.onReady?.(this.botUserId);
      return;
    }

    if (event === "RESUMED") {
      return;
    }

    if (event === "MESSAGE_CREATE") {
      this.handleMessageCreate(data as Record<string, unknown>);
    }
  }

  private handleMessageCreate(msg: Record<string, unknown>): void {
    const author = msg["author"] as Record<string, unknown> | undefined;

    // Ignore bots (including ourselves).
    if (author?.["bot"] === true) return;

    const content = String(msg["content"] ?? "").trim();

    // Parse attachments
    const rawAttachments = Array.isArray(msg["attachments"]) ? msg["attachments"] as Array<Record<string, unknown>> : [];
    const attachments: DiscordAttachment[] = rawAttachments
      .filter((a) => a["id"] && a["url"])
      .map((a) => ({
        id: String(a["id"]),
        filename: String(a["filename"] ?? "attachment"),
        url: String(a["url"]),
        proxyUrl: String(a["proxy_url"] ?? a["url"]),
        contentType: a["content_type"] ? String(a["content_type"]) : undefined,
        size: Number(a["size"] ?? 0),
      }));

    // Require either text content or at least one attachment.
    if (!content && attachments.length === 0) return;

    const channelId = String(msg["channel_id"] ?? "").trim();
    if (!channelId) return;

    const messageId = String(msg["id"] ?? "").trim();
    if (!messageId) return;

    const guildId = msg["guild_id"] ? String(msg["guild_id"]).trim() : undefined;
    const isDm = !guildId;

    // Apply guild filter only to guild messages — always allow DMs through.
    if (!isDm && this.options.guildId && guildId !== this.options.guildId) return;

    const authorId = String(author?.["id"] ?? "").trim();
    const authorName = String(
      author?.["global_name"] ?? author?.["username"] ?? ""
    ).trim();

    // Apply user filter if configured (applies to both DMs and guild messages).
    if (this.options.allowedUserId && authorId !== this.options.allowedUserId) return;

    // channel_name is not always present on the MESSAGE_CREATE payload directly;
    // it would require a separate API call. We omit it here and let the gateway
    // config channelHint fill in the channel name.
    const channelName: string | undefined = undefined;

    void this.options.onMessage({
      messageId,
      channelId,
      channelName,
      guildId,
      authorId,
      authorName,
      content,
      attachments,
      botUserId: this.botUserId,
    });
  }

  private identify(): void {
    this.send({
      op: 2,
      d: {
        token: this.options.botToken,
        intents: DISCORD_INTENTS,
        properties: { os: "linux", browser: "ducki", device: "ducki" },
      },
    });
  }

  private resume(): void {
    this.send({
      op: 6,
      d: {
        token: this.options.botToken,
        session_id: this.sessionId,
        seq: this.sequence,
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // Jitter the first heartbeat as recommended by Discord.
    const jitter = Math.random() * intervalMs;
    this.reconnectTimer = setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
    }, jitter);
  }

  private sendHeartbeat(): void {
    this.send({ op: 1, d: this.sequence });
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
