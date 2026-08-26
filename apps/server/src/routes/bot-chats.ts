import { Router, type IRouter } from "express";
import { createApiResponse, createApiError } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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

/** Recursively list files in a directory relative to a root, returning { path, size, isDirectory } entries. */
function listWorkspaceFiles(rootDir: string, dir: string = rootDir, maxDepth: number = 5): Array<{ path: string; size: number; isDirectory: boolean }> {
  if (maxDepth <= 0) return [];
  const entries: Array<{ path: string; size: number; isDirectory: boolean }> = [];
  try {
    for (const name of readdirSync(dir)) {
      const fullPath = join(dir, name);
      try {
        const stat = statSync(fullPath);
        const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");
        if (stat.isDirectory()) {
          entries.push({ path: relPath + "/", size: 0, isDirectory: true });
          entries.push(...listWorkspaceFiles(rootDir, fullPath, maxDepth - 1));
        } else {
          entries.push({ path: relPath, size: stat.size, isDirectory: false });
        }
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  return entries;
}

/** GET /api/bot-chats/:id/workspace - list files in this group chat's shared workspace. */
botChatsRouter.get("/:id/workspace", (req, res) => {
  const conversationId = parseInt(req.params["id"] ?? "0", 10);
  try {
    const workspaceDir = sharedWorkspace.resolveGroupWorkspace(conversationId);
    const files = listWorkspaceFiles(workspaceDir);
    res.json(createApiResponse({ root: workspaceDir, files }));
  } catch (error) {
    logger.error("Failed to list workspace files", { conversationId, error: error instanceof Error ? error.message : String(error) });
    res.json(createApiResponse({ root: "", files: [] }));
  }
});

/** GET /api/bot-chats/:id/workspace/:filePath - read the contents of a single file in the workspace. */
botChatsRouter.get("/:id/workspace/*", (req, res) => {
  const conversationId = parseInt(req.params["id"] ?? "0", 10);
  const filePath = (req.params as Record<string, string>)["0"]; // wildcard catch-all
  if (!filePath) {
    res.status(400).json(createApiError("File path is required"));
    return;
  }
  try {
    const workspaceDir = sharedWorkspace.resolveGroupWorkspace(conversationId);
    const fullPath = resolve(join(workspaceDir, filePath));
    // Prevent path traversal: the resolved path must be inside the workspace
    if (!fullPath.startsWith(resolve(workspaceDir))) {
      res.status(403).json(createApiError("Access denied"));
      return;
    }
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      res.status(400).json(createApiError("Cannot read a directory"));
      return;
    }
    // Limit preview to 100KB — large files should be downloaded, not previewed
    if (stat.size > 100 * 1024) {
      res.json(createApiResponse({ path: filePath, size: stat.size, truncated: true, content: readFileSync(fullPath, "utf8").slice(0, 100 * 1024) + "\n\n... (truncated at 100KB)" }));
      return;
    }
    const content = readFileSync(fullPath, "utf8");
    res.json(createApiResponse({ path: filePath, size: stat.size, truncated: false, content }));
  } catch (error) {
    res.status(404).json(createApiError("File not found"));
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
 * shows all of them as individual typing indicators in the frontend. Per-process,
 * in-memory: fine for a single server instance, and it only gates polling/overlap protection,
 * never durable conversation state (a restart clears any stale reservation automatically).
 */
const activeGenerations = new Map<number, { activeBots: Array<{ slug: string; name: string; activity: string }>; reserved: boolean }>();

/** GET /api/bot-chats/:id/status - is a background exchange running, and which bots are active? */
botChatsRouter.get("/:id/status", (req, res) => {
  const conversationId = parseInt(req.params["id"] ?? "0", 10);
  const entry = activeGenerations.get(conversationId);
  const generating = entry !== undefined;
  res.json(createApiResponse({ generating, activeBots: generating ? (entry?.activeBots ?? []) : [] }));
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
    activeGenerations.set(conversationId, { activeBots: [], reserved: true });
    generationReserved = true;

    const userMessage = await db.addMessage({ conversationId, role: "user", content: message });
    const participants = await db.listBotChatParticipants(conversationId);
    const botService = getBotService(req);

    const exchange = new BotChatOrchestrator(db, botService)
      .handleUserMessage(conversationId, participants.map((p) => p.botId), message, (bots) => {
        const entry = activeGenerations.get(conversationId);
        if (entry) entry.activeBots = bots;
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
