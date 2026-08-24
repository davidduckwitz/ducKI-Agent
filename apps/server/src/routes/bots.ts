import { Router, type IRouter } from "express";
import { createApiResponse, createApiError } from "@ducki/shared";
import { getRootLogger } from "@ducki/logger";
import type { BotService } from "../lib/bot-service.js";

const logger = getRootLogger().child("BotsRoute");

export const botsRouter: IRouter = Router();

function getBotService(req: import("express").Request): BotService {
  const service = req.app.locals["botService"] as BotService | undefined;
  if (!service) throw new Error("BotService not initialized");
  return service;
}

botsRouter.get("/", async (req, res, next) => {
  try {
    const bots = await getBotService(req).listBots();
    res.json(createApiResponse(bots));
  } catch (error) {
    next(error);
  }
});

botsRouter.get("/:slug", async (req, res, next) => {
  try {
    const bot = await getBotService(req).getBot(req.params["slug"] ?? "");
    if (!bot) {
      res.status(404).json(createApiError("Bot not found"));
      return;
    }
    res.json(createApiResponse(bot));
  } catch (error) {
    next(error);
  }
});

botsRouter.post("/", async (req, res, next) => {
  try {
    const body = req.body as {
      name?: string;
      description?: string;
      avatar?: string;
      systemPrompt?: string;
      providerId?: string;
      modelId?: string;
      skillWhitelist?: string[];
      toolWhitelist?: string[];
    };
    if (!body.name || typeof body.name !== "string") {
      res.status(400).json(createApiError("Bot name is required"));
      return;
    }
    const bot = await getBotService(req).createBot({ ...body, name: body.name });
    res.json(createApiResponse(bot));
  } catch (error) {
    next(error);
  }
});

botsRouter.patch("/:slug", async (req, res, next) => {
  try {
    const bot = await getBotService(req).updateBot(req.params["slug"] ?? "", req.body ?? {});
    res.json(createApiResponse(bot));
  } catch (error) {
    if (error instanceof Error && (error.message === "Bot not found" || error.message === "Built-in bots cannot be edited")) {
      res.status(error.message === "Bot not found" ? 404 : 403).json(createApiError(error.message));
      return;
    }
    next(error);
  }
});

botsRouter.delete("/:slug", async (req, res, next) => {
  try {
    await getBotService(req).deleteBot(req.params["slug"] ?? "");
    res.json(createApiResponse({ deleted: true }));
  } catch (error) {
    if (error instanceof Error && (error.message === "Bot not found" || error.message === "Built-in bots cannot be deleted")) {
      res.status(error.message === "Bot not found" ? 404 : 403).json(createApiError(error.message));
      return;
    }
    next(error);
  }
});

/**
 * POST /api/bots/:slug/chat - send a message to a bot in its own persistent home conversation.
 * BotService.chat() owns the "coding" bot's differently-shaped CodingAgent.run() branch, shared
 * with the delegate_to_bot tool (see lib/delegate-to-bot-tool.ts) so it exists exactly once.
 */
botsRouter.post("/:slug/chat", async (req, res, next) => {
  const agentRegistry = req.app.locals["agentRegistry"] as {
    register: (entry: { source: "chat_http"; conversationId?: number; label?: string }) => string;
    unregister: (id: string) => void;
  };
  let runId: string | undefined;
  try {
    const botService = getBotService(req);
    const bot = await botService.getBot(req.params["slug"] ?? "");
    if (!bot) {
      res.status(404).json(createApiError("Bot not found"));
      return;
    }

    const { message } = req.body as { message?: string };
    if (!message || typeof message !== "string") {
      res.status(400).json(createApiError("Message is required"));
      return;
    }

    runId = agentRegistry.register({ source: "chat_http", label: `Bot: ${bot.name}` });
    const result = await botService.chat(bot, message);
    res.json(createApiResponse(result));
  } catch (error) {
    logger.error("Bot chat failed", { error: error instanceof Error ? error.message : String(error) });
    next(error);
  } finally {
    if (runId) agentRegistry.unregister(runId);
  }
});
