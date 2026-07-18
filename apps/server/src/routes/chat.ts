import { Router, type IRouter } from "express";
import type { Agent } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse, createApiError } from "@ducki/shared";

export const chatRouter: IRouter = Router();

chatRouter.get("/conversations", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const projectIdRaw = req.query["projectId"] as string | undefined;
    const projectId = projectIdRaw ? parseInt(projectIdRaw) : undefined;
    const conversations = await db.listConversations(Number.isFinite(projectId) ? projectId : undefined);
    res.json(createApiResponse(conversations));
  } catch (error) {
    next(error);
  }
});

chatRouter.get("/conversations/page", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const projectIdRaw = req.query["projectId"] as string | undefined;
    const beforeIdRaw = req.query["beforeId"] as string | undefined;
    const limitRaw = req.query["limit"] as string | undefined;

    const projectId = projectIdRaw ? parseInt(projectIdRaw, 10) : undefined;
    const beforeId = beforeIdRaw ? parseInt(beforeIdRaw, 10) : undefined;
    const limit = limitRaw ? parseInt(limitRaw, 10) : 30;

    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 30;
    const items = await db.listConversationsPage({
      projectId: Number.isFinite(projectId) ? projectId : undefined,
      beforeId: Number.isFinite(beforeId) ? beforeId : undefined,
      limit: boundedLimit + 1,
    });

    const hasMore = items.length > boundedLimit;
    const pageItems = hasMore ? items.slice(0, boundedLimit) : items;
    const last = pageItems[pageItems.length - 1];

    res.json(
      createApiResponse({
        items: pageItems,
        hasMore,
        nextBeforeId: hasMore ? last?.id : undefined,
      })
    );
  } catch (error) {
    next(error);
  }
});

chatRouter.get("/conversations/:id/messages", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const conversationId = parseInt(req.params["id"] ?? "0");
    if (!Number.isFinite(conversationId) || conversationId <= 0) {
      res.status(400).json(createApiError("Invalid conversation id"));
      return;
    }

    const conversation = await db.getConversation(conversationId);
    if (!conversation) {
      res.status(404).json(createApiError("Conversation not found"));
      return;
    }

    const messages = await db.getMessages(conversationId);
    res.json(createApiResponse(messages));
  } catch (error) {
    next(error);
  }
});

chatRouter.get("/conversations/:id/messages/page", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const conversationId = parseInt(req.params["id"] ?? "0", 10);
    const beforeIdRaw = req.query["beforeId"] as string | undefined;
    const limitRaw = req.query["limit"] as string | undefined;

    if (!Number.isFinite(conversationId) || conversationId <= 0) {
      res.status(400).json(createApiError("Invalid conversation id"));
      return;
    }

    const conversation = await db.getConversation(conversationId);
    if (!conversation) {
      res.status(404).json(createApiError("Conversation not found"));
      return;
    }

    const beforeId = beforeIdRaw ? parseInt(beforeIdRaw, 10) : undefined;
    const limit = limitRaw ? parseInt(limitRaw, 10) : 50;
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50;

    const items = await db.getMessagesPage({
      conversationId,
      beforeId: Number.isFinite(beforeId) ? beforeId : undefined,
      limit: boundedLimit + 1,
    });

    const hasMore = items.length > boundedLimit;
    const pageItems = hasMore ? items.slice(1) : items;
    const first = pageItems[0];

    res.json(
      createApiResponse({
        items: pageItems,
        hasMore,
        nextBeforeId: hasMore ? first?.id : undefined,
      })
    );
  } catch (error) {
    next(error);
  }
});

chatRouter.get("/search", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const query = String(req.query["query"] ?? "").trim().toLowerCase();
    const limitRaw = Number(req.query["limit"] ?? 20);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 20;

    if (!query) {
      res.status(400).json(createApiError("query is required"));
      return;
    }

    const conversations = await db.listConversations();
    const results: Array<{
      conversationId: number;
      conversationName: string;
      messageId: number;
      role: string;
      content: string;
      createdAt: string;
    }> = [];

    for (const conversation of conversations) {
      const messages = await db.getMessages(conversation.id);
      for (const message of messages) {
        if (!String(message.content ?? "").toLowerCase().includes(query)) continue;
        results.push({
          conversationId: conversation.id,
          conversationName: conversation.name,
          messageId: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
        });
        if (results.length >= limit) {
          res.json(createApiResponse(results));
          return;
        }
      }
    }

    res.json(createApiResponse(results));
  } catch (error) {
    next(error);
  }
});

chatRouter.post("/", async (req, res, next) => {
  let runId: string | undefined;
  try {
    const createAgent = req.app.locals["createAgent"] as (() => Agent) | undefined;
    const agent = createAgent ? createAgent() : (req.app.locals["agent"] as Agent);
    const agentRegistry = req.app.locals["agentRegistry"] as {
      register: (entry: { source: "chat_http" | "chat_ws" | "task_run"; conversationId?: number; taskId?: number; socketId?: string; label?: string }) => string;
      unregister: (id: string) => void;
    };
    const { message, conversationId, stream } = req.body as {
      message: string;
      conversationId?: number;
      stream?: boolean;
    };

    if (!message || typeof message !== "string") {
      res.status(400).json(createApiError("Message is required"));
      return;
    }

    let activeConversationId: number | undefined;
    if (conversationId) {
      await agent.loadConversation(conversationId);
      activeConversationId = conversationId;
    } else {
      activeConversationId = await agent.startConversation();
    }

    runId = agentRegistry.register({
      source: "chat_http",
      conversationId: activeConversationId,
      label: "HTTP Chat",
    });

    const result = await agent.run(message);
    res.json(createApiResponse(result));
  } catch (error) {
    next(error);
  } finally {
    const agentRegistry = req.app.locals["agentRegistry"] as { unregister: (id: string) => void };
    if (runId) agentRegistry.unregister(runId);
  }
});

chatRouter.post("/conversation", async (req, res, next) => {
  try {
    const createAgent = req.app.locals["createAgent"] as (() => Agent) | undefined;
    const agent = createAgent ? createAgent() : (req.app.locals["agent"] as Agent);
    const { name, projectId } = req.body as { name?: string; projectId?: number };
    const convId = await agent.startConversation({ name, projectId });
    res.json(createApiResponse({ conversationId: convId }));
  } catch (error) {
    next(error);
  }
});

