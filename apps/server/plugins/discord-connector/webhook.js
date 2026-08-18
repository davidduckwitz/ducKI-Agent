/**
 * Discord webhook handling: Ed25519 interaction signature verification + slash-command
 * interaction parsing. Moved out of apps/server/src/routes/gateway.ts (see
 * docs/gateway-connector-plugin-plan.md section 6, migration step 4).
 *
 * Deviation from the pre-migration behavior: interaction replies are now delivered as a normal
 * bot-API channel message (via send.js, same as the WS gateway path) instead of PATCHing the
 * deferred interaction response ("@original"). This lets interactions flow through the same
 * generic, portal-neutral inbound->agent->send() pipeline as every other inbound message
 * instead of needing interaction-token-specific reply plumbing kept in core. The visible
 * difference: Discord shows the bot's "thinking..." placeholder AND a separate follow-up
 * message, instead of the placeholder being edited in place.
 */

import { createPublicKey, verify } from "node:crypto";
import { Buffer } from "node:buffer";

export function verifyDiscordSignature(publicKeyHex, rawBody, timestamp, signature) {
  if (!publicKeyHex || !rawBody || !timestamp || !signature) return false;
  try {
    const keyBytes = Buffer.from(publicKeyHex, "hex");
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const publicKey = createPublicKey({
      key: Buffer.concat([spkiPrefix, keyBytes]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(`${timestamp}${rawBody}`), publicKey, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

function shouldVerify(body, headers) {
  const payload = body && typeof body === "object" ? body : undefined;
  const interactionType = Number(payload?.["type"] ?? 0);
  return interactionType > 0 || Boolean(headers["x-signature-ed25519"] && headers["x-signature-timestamp"]);
}

function parseInteraction(body) {
  if (!body || typeof body !== "object") return undefined;
  const payload = body;
  const interactionType = Number(payload["type"] ?? 0);
  if (![2, 3].includes(interactionType)) return undefined;

  const applicationId = String(payload["application_id"] ?? "").trim();
  const interactionToken = String(payload["token"] ?? "").trim();
  const channelId = String(payload["channel_id"] ?? "").trim();
  const guildId = String(payload["guild_id"] ?? "").trim();
  const member = payload["member"];
  const user = member?.["user"] ?? payload["user"];
  const userId = String(user?.["id"] ?? "").trim();
  if (!applicationId || !interactionToken) return undefined;

  const data = payload["data"];
  const commandName = String(data?.["name"] ?? "discord").trim() || "discord";
  const options = Array.isArray(data?.["options"]) ? data["options"] : [];
  const optionParts = options
    .map((option) => {
      const name = String(option?.["name"] ?? "").trim();
      const value = option?.["value"];
      if (!name || value === undefined || value === null) return undefined;
      return `${name}: ${String(value).trim()}`;
    })
    .filter((value) => Boolean(value));
  const primaryOption = options.find((option) => typeof option?.["value"] === "string");
  const message = String(primaryOption?.["value"] ?? [commandName, ...optionParts].join(" | ")).trim();
  if (!message) return undefined;

  const channelIdOrFallback = channelId || guildId || userId || `interaction-${applicationId}`;
  const channelName = String(payload["channel_name"] ?? channelId ?? guildId ?? userId).trim() || channelIdOrFallback;
  const userName = String(user?.["username"] ?? member?.["nick"] ?? "").trim() || undefined;

  return {
    externalConversationId: channelIdOrFallback,
    hasChannelId: Boolean(channelId),
    message,
    channelName,
    userName,
    authorId: userId || undefined,
  };
}

/**
 * Handles one webhook POST for the discord-connector. `req` is the portal-neutral
 * ConnectorWebhookRequest shape (body/headers/rawBody/params). `ctx` provides settings/secrets
 * (publicKey) and the inbound dispatch hook. Returns undefined only if the payload cannot be
 * recognized as a Discord webhook call at all (caller can then fall back to legacy handling).
 */
export async function handleDiscordWebhook(ctx, req) {
  const publicKey = String(ctx.settings["publicKey"] ?? "").trim();

  if (shouldVerify(req.body, req.headers)) {
    const signature = String(req.headers["x-signature-ed25519"] ?? "").trim();
    const timestamp = String(req.headers["x-signature-timestamp"] ?? "").trim();
    const rawBody = String(req.rawBody ?? "");
    if (!signature || !timestamp || !rawBody) {
      return { status: 401, body: { error: "Missing Discord signature headers or raw body" } };
    }
    if (!publicKey) {
      ctx.logger.warn("Discord webhook received but no publicKey configured - rejecting");
      return { status: 401, body: { error: "Discord public key not configured" } };
    }
    if (!verifyDiscordSignature(publicKey, rawBody, timestamp, signature)) {
      return { status: 401, body: { error: "Invalid Discord request signature" } };
    }
  }

  const interactionType = Number(req.body?.["type"] ?? 0);
  if (interactionType === 1) {
    return { status: 200, body: { type: 1 } }; // PING
  }

  const interaction = parseInteraction(req.body);
  if (!interaction) {
    if ([2, 3].includes(interactionType)) {
      return {
        status: 200,
        body: { type: 4, data: { content: "Interaktion empfangen, aber das Payload-Format wurde nicht erkannt." } },
      };
    }
    return undefined;
  }

  if (!interaction.hasChannelId) {
    ctx.logger.warn("Discord interaction has no channel_id - cannot deliver a reply, acknowledging only");
    return { status: 200, body: { type: 4, data: { content: "Interaktion ohne Kanal-Kontext kann nicht beantwortet werden." } } };
  }

  // Defer the interaction response immediately, then process + reply asynchronously as a
  // normal channel message (see module docstring for why).
  void ctx.onInboundMessage({
    portal: ctx.portal,
    externalConversationId: interaction.externalConversationId,
    channelName: interaction.channelName,
    userName: interaction.userName,
    authorId: interaction.authorId,
    content: interaction.message,
  }).catch((error) => {
    ctx.logger.warn("Discord interaction inbound dispatch failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return { status: 200, body: { type: 5 } }; // ACK_WITH_SOURCE (deferred)
}
