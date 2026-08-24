import { Router, type IRouter } from "express";
import { createApiResponse, createApiError } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import type { BotService } from "../lib/bot-service.js";
import { BotChatOrchestrator } from "../lib/bot-chat-orchestrator.js";
import { sharedWorkspace } from "../lib/shared-workspace-service.js";

const logger = getRootLogger().child("BotChatsRoute");

export const botChatsRouter: IRouter = Router();

function getDb(req: import("express").Request): DatabaseService {
  return req.app.locals["db"] as DatabaseService;
}

function getBotService(req: import("express").Request): BotService {
  const service = req.app.locals["botService"] as BotService | undefined;
  if (!service) throw new Error("BotService not initialized");
  return service;
}

/** GET /api/bot-chats - all group bot chats, newest first, each with its participant slugs. */
botChatsRouter.get("/", async (req, res, next) => {
  try {
    const db = getDb(req);
    const chats = await db.listBotChats();
    const withParticipants = await Promise.all(
      chats.map(async (chat) => ({
        ...chat,
        participants: (await db.listBotChatParticipants(chat.id)).map((p) => p.botId),
      }))
    );
    res.json(createApiResponse(withParticipants));
  } catch (error) {
    next(error);
  }
});

/** POST /api/bot-chats - create a new group chat with an initial set of bots. */
botChatsRouter.post("/", async (req, res, next) => {
  try {
    const db = getDb(req);
    const { name, botSlugs } = req.body as { name?: string; botSlugs?: string[] };
    if (!Array.isArray(botSlugs) || botSlugs.length < 2) {
      res.status(400).json(createApiError("botSlugs must contain at least 2 bot slugs"));
      return;
    }

    const botService = getBotService(req);
    const resolvedBots = [];
    for (const slug of botSlugs) {
      const bot = await botService.getBot(slug);
      if (!bot) {
        res.status(400).json(createApiError(`No bot with slug '${slug}'`));
        return;
      }
      resolvedBots.push(bot);
    }

    const conversation = await db.createConversation({
      name: name?.trim() || resolvedBots.map((b) => b.name).join(" & "),
      origin: "bot_chat",
    });
    for (const bot of resolvedBots) {
      await db.addBotChatParticipant(conversation.id, bot.slug);
    }

    // Create the shared workspace on disk and inject its context into the
    // transcript so every bot in this chat sees the shared filesystem from
    // the very first exchange. Tagged internal so it doesn't clutter the UI.
    await sharedWorkspace.injectWorkspaceContext(db, conversation.id, conversation.id);

    res.json(createApiResponse({ ...conversation, participants: resolvedBots.map((b) => b.slug) }));
  } catch (error) {
    next(error);
  }
});

/** GET /api/bot-chats/:id - one chat's conversation row plus its participant slugs. */
botChatsRouter.get("/:id", async (req, res, next) => {
  try {
    const db = getDb(req);
    const conversationId = parseInt(req.params["id"] ?? "0", 10);
    const conversation = await db.getConversation(conversationId);
    if (!conversation || conversation.origin !== "bot_chat") {
      res.status(404).json(createApiError("Bot chat not found"));
      return;
    }
    const participants = await db.listBotChatParticipants(conversationId);
    res.json(createApiResponse({ ...conversation, participants: participants.map((p) => p.botId) }));
  } catch (error) {
    next(error);
  }
});

/** GET /api/bot-chats/:id/messages - transcript, same row shape as /api/chat/conversations/:id/messages
 *  (with authorBotId set on bot turns so the UI can render the right avatar/name per message). */
botChatsRouter.get("/:id/messages", async (req, res, next) => {
  try {
    const db = getDb(req);
    const conversationId = parseInt(req.params["id"] ?? "0", 10);
    const messages = await db.getMessages(conversationId);
    res.json(createApiResponse(messages));
  } catch (error) {
    next(error);
  }
});

/** DELETE /api/bot-chats/:id - delete the whole group chat (conversation, messages, participants). */
botChatsRouter.delete("/:id", async (req, res, next) => {
  try {
    const db = getDb(req);
    const conversationId = parseInt(req.params["id"] ?? "0", 10);
    const conversation = await db.getConversation(conversationId);
    if (!conversation || conversation.origin !== "bot_chat") {
      res.status(404).json(createApiError("Bot chat not found"));
      return;
    }
    await db.deleteConversation(conversationId);
    res.json(createApiResponse({ deleted: true }));
  } catch (error) {
    next(error);
  }
});

/** DELETE /api/bot-chats/:id/messages/:messageId - remove a single message, e.g. to declutter a
 *  group chat without wiping the whole history. */
botChatsRouter.delete("/:id/messages/:messageId", async (req, res, next) => {
  try {
    const db = getDb(req);
    const conversationId = parseInt(req.params["id"] ?? "0", 10);
    const messageId = parseInt(req.params["messageId"] ?? "0", 10);
    const deleted = await db.deleteMessage(conversationId, messageId);
    if (!deleted) {
      res.status(404).json(createApiError("Message not found in this chat"));
      return;
    }
    res.json(createApiResponse({ deleted: true }));
  } catch (error) {
    next(error);
  }
});

/** POST /api/bot-chats/:id/participants - add a bot to an existing chat. */
botChatsRouter.post("/:id/participants", async (req, res, next) => {
  try {
    const db = getDb(req);
    const conversationId = parseInt(req.params["id"] ?? "0", 10);
    const { botId } = req.body as { botId?: string };
    if (!botId) {
      res.status(400).json(createApiError("botId is required"));
      return;
    }
    const bot = await getBotService(req).getBot(botId);
    if (!bot) {
      res.status(400).json(createApiError(`No bot with slug '${botId}'`));
      return;
    }
    await db.addBotChatParticipant(conversationId, botId);
    res.json(createApiResponse({ added: true }));
  } catch (error) {
    next(error);
  }
});

/** DELETE /api/bot-chats/:id/participants/:botId - remove a bot from a chat. */
botChatsRouter.delete("/:id/participants/:botId", async (req, res, next) => {
  try {
    const db = getDb(req);
    const conversationId = parseInt(req.params["id"] ?? "0", 10);
    await db.removeBotChatParticipant(conversationId, req.params["botId"] ?? "");
    res.json(createApiResponse({ removed: true }));
  } catch (error) {
    next(error);
  }
});

/**
 * Which conversations currently have a background exchange running, and one representative bot
 * that is actively generating right now. A parallel batch can have several active bots; the UI
 * deliberately shows one of them as the typing indicator rather than exposing scheduler detail.
 * Polled via GET /:id/status so the UI knows when to stop polling for new messages. Per-process,
 * in-memory: fine for a single server instance, and it only gates polling/overlap protection,
 * never durable conversation state (a restart clears any stale reservation automatically).
 */
const activeGenerations = new Map<number, { slug: string; name: string } | null>();

/** GET /api/bot-chats/:id/status - is a background exchange running, and which bot is active? */
botChatsRouter.get("/:id/status", (req, res) => {
  const conversationId = parseInt(req.params["id"] ?? "0", 10);
  const generating = activeGenerations.has(conversationId);
  res.json(createApiResponse({ generating, activeBot: generating ? (activeGenerations.get(conversationId) ?? null) : null }));
});

/**
 * POST /api/bot-chats/:id/messages - send a user message into the group chat. Persists the
 * message and responds immediately, then runs the BotChatOrchestrator exchange in the
 * background: each bot's reply is written to `messages` (and tagged) the moment that bot
 * finishes, independent of the others, so polling GET /:id/messages (+ /:id/status to know when
 * the whole exchange has settled) shows replies as they actually happen instead of the client
 * waiting for the slowest bot before seeing anything.
 *
 * Only ONE exchange may mutate a given bot-chat conversation at once. A second user message while
 * the first exchange is still running is rejected with 409 before it is persisted. Without this
 * reservation two orchestrators could overlap, invalidating the parallel round-snapshot barrier
 * and making handoff/mention order depend on timing. The UI already knows the generating state;
 * API clients get an explicit retryable conflict instead of silent history corruption.
 */
botChatsRouter.post("/:id/messages", async (req, res, next) => {
  const conversationId = parseInt(req.params["id"] ?? "0", 10);
  let generationReserved = false;

  try {
    const db = getDb(req);
    const conversation = await db.getConversation(conversationId);
    if (!conversation || conversation.origin !== "bot_chat") {
      res.status(404).json(createApiError("Bot chat not found"));
      return;
    }

    const { message } = req.body as { message?: string };
    if (!message || typeof message !== "string") {
      res.status(400).json(createApiError("Message is required"));
      return;
    }

    if (activeGenerations.has(conversationId)) {
      res.status(409).json(createApiError("A bot-chat exchange is already running for this conversation"));
      return;
    }

    // Reserve BEFORE the first awaited write below. Node can accept another HTTP request while
    // addMessage/listBotChatParticipants are pending; setting the flag later leaves a window where
    // two requests both pass the overlap check and start two orchestrators.
    activeGenerations.set(conversationId, null);
    generationReserved = true;

    const userMessage = await db.addMessage({ conversationId, role: "user", content: message });
    const participants = await db.listBotChatParticipants(conversationId);
    const botService = getBotService(req);

    const exchange = new BotChatOrchestrator(db, botService)
      .handleUserMessage(conversationId, participants.map((p) => p.botId), message, (bot) => {
        activeGenerations.set(conversationId, bot);
      })
      .catch((error) => {
        logger.error("Bot chat exchange failed", {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        activeGenerations.delete(conversationId);
      });

    // From here the background exchange owns the reservation and clears it in finally().
    generationReserved = false;
    void exchange;

    res.json(createApiResponse({ started: true, userMessageId: userMessage.id }));
  } catch (error) {
    if (generationReserved) activeGenerations.delete(conversationId);
    logger.error("Bot chat message failed", { error: error instanceof Error ? error.message : String(error) });
    next(error);
  }
});
