import { isReasoningEffort, type ReasoningEffort } from "@ducki/shared";
import { Router, type IRouter } from "express";
import type { Agent } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse, createApiError } from "@ducki/shared";
import { getRootLogger } from "@ducki/logger";
import { runAgentWithRepairRetry } from "../lib/agent-retry.js";

const logger = getRootLogger().child("ChatRoute");
import { ChatCleanupService } from "../lib/chat-cleanup-service.js";
import { deriveConversationTitle } from "../lib/conversation-title.js";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import express from "express";
import { transcribeAudioBuffer } from "../lib/audio-transcription.js";
import { synthesizeSpeech } from "../lib/audio-synthesis.js";
import { listElevenLabsVoices, listBreezeVoices, listChatterboxVoices, isChatterboxServerReachable } from "@ducki/providers";

export const chatRouter: IRouter = Router();

// Middleware to handle raw binary data for transcribe endpoint
chatRouter.post("/transcribe", async (req, res, next) => {
  const startTime = Date.now();

  try {
    const body = req.body as any;
    const base64Audio = body?.audio;

    if (!base64Audio) {
      res.status(400).json(createApiError("Audio data is required"));
      return;
    }

    // Decode base64 to buffer (like Discord Gateway does)
    const audioBuffer = Buffer.from(String(base64Audio), "base64");

    if (audioBuffer.length === 0) {
      res.status(400).json(createApiError("Audio data is empty"));
      return;
    }

    const db = req.app.locals["db"] as DatabaseService;
    const text = await transcribeAudioBuffer(db, audioBuffer, {
      language: typeof body.language === "string" ? body.language : undefined,
      mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined,
      partial: body.partial === true,
    });

    const elapsed = Date.now() - startTime;

    logger.debug("Transcribe success", { elapsedMs: elapsed, textPreview: text.substring(0, 100) });

    res.json(
      createApiResponse({
        text: text || "",
      })
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error("Transcribe failed", { error: errorMsg });
    res.status(500).json(
      createApiError(`Transkription fehlgeschlagen: ${errorMsg}`)
    );
  }
});

chatRouter.post("/speak", async (req, res) => {
  const startTime = Date.now();

  try {
    const body = req.body as {
      text?: unknown;
      voice?: unknown;
      emotionStyle?: unknown;
      emotionInstructions?: unknown;
      language?: unknown;
    };
    const text = typeof body?.text === "string" ? body.text.trim() : "";

    if (!text) {
      res.status(400).json(createApiError("Text is required"));
      return;
    }

    const db = req.app.locals["db"] as DatabaseService;
    const { audio, mimeType } = await synthesizeSpeech(db, text, {
      voice: typeof body?.voice === "string" ? body.voice : undefined,
      emotionStyle: typeof body?.emotionStyle === "string" ? body.emotionStyle : undefined,
      emotionInstructions: typeof body?.emotionInstructions === "string" ? body.emotionInstructions : undefined,
      language: typeof body?.language === "string" ? body.language : undefined,
    });

    const elapsed = Date.now() - startTime;
    logger.debug("Speak success", { elapsedMs: elapsed, textLength: text.length });

    res.json(createApiResponse({ audio: audio.toString("base64"), mimeType }));
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error("Speak failed", { error: errorMsg });
    res.status(500).json(createApiError(`Sprachausgabe fehlgeschlagen: ${errorMsg}`));
  }
});

chatRouter.get("/tts-voices", async (req, res) => {
  try {
    const provider = String(req.query["provider"] ?? "");
    const query = typeof req.query["q"] === "string" ? req.query["q"] : undefined;
    const db = req.app.locals["db"] as DatabaseService;
    const allSettings = await db.getAllSettings();
    const settingValue = (key: string) => allSettings.find((s) => s.key === key)?.value;

    if (provider === "elevenlabs") {
      const apiKey = settingValue("ELEVENLABS_API_KEY");
      if (!apiKey) {
        res.json(createApiResponse({ voices: [] }));
        return;
      }
      const voices = await listElevenLabsVoices(apiKey);
      res.json(createApiResponse({ voices }));
      return;
    }

    if (provider === "breeze") {
      const apiKey = settingValue("BREEZE_API_KEY");
      if (!apiKey) {
        res.json(createApiResponse({ voices: [] }));
        return;
      }
      const voices = await listBreezeVoices(apiKey, query);
      res.json(createApiResponse({ voices }));
      return;
    }

    if (provider === "chatterbox") {
      const serverUrl = settingValue("CHATTERBOX_SERVER_URL") || "http://127.0.0.1:8890";
      const chatterboxVoices = await listChatterboxVoices(serverUrl);
      // Normalize {id, name} to the {voiceId, name} shape every other provider uses, so the
      // client's voice picker doesn't need a provider-specific field mapping.
      const voices = chatterboxVoices.map((v) => ({ voiceId: v.id, name: v.name }));
      res.json(createApiResponse({ voices }));
      return;
    }

    // OpenAI's voice set is a small fixed list - nothing worth a network round-trip for.
    res.json(createApiResponse({ voices: [] }));
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error("TTS voice listing failed", { error: errorMsg });
    res.status(500).json(createApiError(`Stimmen-Abruf fehlgeschlagen: ${errorMsg}`));
  }
});

chatRouter.get("/tts-health", async (req, res) => {
  try {
    const provider = String(req.query["provider"] ?? "");
    if (provider !== "chatterbox") {
      res.json(createApiResponse({ reachable: true }));
      return;
    }
    const db = req.app.locals["db"] as DatabaseService;
    const allSettings = await db.getAllSettings();
    const serverUrl = allSettings.find((s) => s.key === "CHATTERBOX_SERVER_URL")?.value || "http://127.0.0.1:8890";
    const reachable = await isChatterboxServerReachable(serverUrl);
    res.json(createApiResponse({ reachable, serverUrl }));
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json(createApiError(`Health-Check fehlgeschlagen: ${errorMsg}`));
  }
});

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

/** GET /chat/conversations/:id - single conversation row (name, projectId, pluginContext, ...).
 *  Needed by the chat UI to reliably resolve a conversation's pluginContext even when it has
 *  scrolled off the currently-loaded page of the sidebar's paginated conversation list. */
chatRouter.get("/conversations/:id", async (req, res, next) => {
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
    res.json(createApiResponse(conversation));
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
    const { message, conversationId, stream, provider, model, reasoningEffort } = req.body as {
      message: string;
      conversationId?: number;
      stream?: boolean;
      provider?: string;
      model?: string;
      reasoningEffort?: ReasoningEffort;
    };
    if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort)) {
      res.status(400).json(createApiError("Invalid reasoningEffort: expected off, low, medium, high or xhigh"));
      return;
    }
    const createAgent = req.app.locals["createAgent"] as ((override?: { provider?: string; model?: string }) => Promise<Agent>) | undefined;
    const requestedProvider = typeof provider === "string" && provider.trim() ? provider.trim() : undefined;
    const requestedModel = typeof model === "string" && model.trim() ? model.trim() : undefined;
    const hasOverride = requestedProvider || requestedModel;
    const createRequestAgent = createAgent ? () => createAgent(hasOverride ? { provider: requestedProvider, model: requestedModel } : undefined) : undefined;
    const agent = createRequestAgent ? await createRequestAgent() : (req.app.locals["agent"] as Agent);
    const agentRegistry = req.app.locals["agentRegistry"] as {
      register: (entry: { source: "chat_http" | "chat_ws" | "task_run"; conversationId?: number; taskId?: number; socketId?: string; label?: string }, controls?: { stop?: () => void }) => string;
      unregister: (id: string) => void;
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
      activeConversationId = await agent.startConversation({ name: deriveConversationTitle(message) });
    }

    const clientRunId = typeof req.body?.clientRunId === "string" ? req.body.clientRunId.trim().slice(0, 100) : "";
    runId = agentRegistry.register({
      source: "chat_http",
      conversationId: activeConversationId,
      label: clientRunId ? `Erpel:${clientRunId}` : "HTTP Chat",
    }, { stop: () => agent.stop() });

    const wantsDiscordDelivery = /(?:\b(?:auf|an|zu|to)\s+discord\b|\bdiscord\b.*\b(?:antwort|reply|post|poste|sende|send|schick|schreibe)\b|\b(?:antwort|reply|post|poste|sende|send|schick|schreibe)\b.*\bdiscord\b)/i.test(message);
    const routedMessage = wantsDiscordDelivery
      ? [
          "[Routing hint: The user explicitly wants the answer to be delivered on Discord. Treat this as an outbound gateway operation, not a normal chat reply. If the Discord target is unclear, ask for the target channel instead of guessing. Use gateway action=list_configs before gateway action=send in the same run.]",
          message,
        ].join("\n\n")
      : message;

    const result = await runAgentWithRepairRetry(
      createRequestAgent ?? (async () => agent),
      routedMessage,
      (errorMessage) => [
        "The previous chat run failed with a runtime error.",
        `Error: ${errorMessage}`,
        "Start over from scratch with a fresh solution path.",
        routedMessage,
      ].join("\n"),
      async (runAgent) => {
        // activeConversationId is always set by this point (either the caller-provided id,
        // or the one just created above) - reuse it here instead of calling
        // startConversation() again, which previously created a second, disconnected
        // conversation row that only the very first message of every new chat ever wrote to.
        await runAgent.loadConversation(activeConversationId);
      },
      { reasoningEffort }
    );
    res.json(createApiResponse(result.result));

    // Background review fork: analyze the turn for learnings (fire-and-forget).
    const bgReview = req.app.locals["bgReview"] as { runAfterTurn: (userInput: string, finalResponse: string, conversationId: number) => Promise<void> } | undefined;
    if (bgReview && activeConversationId) {
      void bgReview.runAfterTurn(message, result.result.response, activeConversationId);
    }
  } catch (error) {
    next(error);
  } finally {
    const agentRegistry = req.app.locals["agentRegistry"] as { unregister: (id: string) => void };
    if (runId) agentRegistry.unregister(runId);
  }
});

chatRouter.post("/conversation", async (req, res, next) => {
  try {
    const createAgent = req.app.locals["createAgent"] as (() => Promise<Agent>) | undefined;
    const agent = createAgent ? await createAgent() : (req.app.locals["agent"] as Agent);
    const { name, projectId } = req.body as { name?: string; projectId?: number };
    const convId = await agent.startConversation({ name, projectId });
    res.json(createApiResponse({ conversationId: convId }));
  } catch (error) {
    next(error);
  }
});

chatRouter.patch("/conversations/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const conversationId = parseInt(req.params["id"] ?? "0", 10);
    if (!Number.isFinite(conversationId) || conversationId <= 0) {
      res.status(400).json(createApiError("Invalid conversation id"));
      return;
    }

    const { projectId, name } = req.body as { projectId?: number; name?: string };
    const updated = await db.updateConversation(conversationId, { projectId, name });
    if (!updated) {
      res.status(404).json(createApiError("Conversation not found"));
      return;
    }

    res.json(createApiResponse(updated));
  } catch (error) {
    next(error);
  }
});

chatRouter.delete("/conversations/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const conversationId = parseInt(req.params["id"] ?? "0", 10);
    if (!Number.isFinite(conversationId) || conversationId <= 0) {
      res.status(400).json(createApiError("Invalid conversation id"));
      return;
    }

    const existing = await db.getConversation(conversationId);
    if (!existing) {
      res.status(404).json(createApiError("Conversation not found"));
      return;
    }

    await db.deleteConversation(conversationId);
    res.json(createApiResponse({ deleted: true, id: conversationId }));
  } catch (error) {
    next(error);
  }
});

chatRouter.delete("/conversations/:id/messages", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const conversationId = parseInt(req.params["id"] ?? "0", 10);
    if (!Number.isFinite(conversationId) || conversationId <= 0) {
      res.status(400).json(createApiError("Invalid conversation id"));
      return;
    }

    const existing = await db.getConversation(conversationId);
    if (!existing) {
      res.status(404).json(createApiError("Conversation not found"));
      return;
    }

    await db.deleteMessages(conversationId);
    res.json(createApiResponse({ cleared: true, conversationId }));
  } catch (error) {
    next(error);
  }
});

chatRouter.post("/conversations/:id/archive", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const conversationId = parseInt(req.params["id"] ?? "0", 10);
    const { reason } = req.body as { reason?: string };

    if (!Number.isFinite(conversationId) || conversationId <= 0) {
      res.status(400).json(createApiError("Invalid conversation id"));
      return;
    }

    const existing = await db.getConversation(conversationId);
    if (!existing) {
      res.status(404).json(createApiError("Conversation not found"));
      return;
    }

    const archived = await db.archiveConversation(conversationId, reason);
    res.json(createApiResponse({ archived: true, archiveId: archived.id }));
  } catch (error) {
    next(error);
  }
});

chatRouter.get("/archived", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const limitRaw = req.query["limit"] as string | undefined;
    const limit = limitRaw ? Math.max(1, Math.min(200, parseInt(limitRaw, 10))) : 100;
    const archived = await db.listArchivedConversations(limit);
    res.json(createApiResponse(archived));
  } catch (error) {
    next(error);
  }
});

chatRouter.delete("/archived/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const archiveId = parseInt(req.params["id"] ?? "0", 10);

    if (!Number.isFinite(archiveId) || archiveId <= 0) {
      res.status(400).json(createApiError("Invalid archive id"));
      return;
    }

    await db.deleteArchivedConversation(archiveId);
    res.json(createApiResponse({ deleted: true, id: archiveId }));
  } catch (error) {
    next(error);
  }
});

chatRouter.get("/cleanup/config", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const logger = req.app.locals["logger"] || console;
    const cleanup = new ChatCleanupService(db, logger as any);
    const config = await cleanup.loadConfig();
    res.json(createApiResponse(config));
  } catch (error) {
    next(error);
  }
});

chatRouter.post("/cleanup/config", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const logger = req.app.locals["logger"] || console;
    const cleanup = new ChatCleanupService(db, logger as any);
    const { maxMessagesPerConversation, archiveAfterDaysInactive, autoCleanupEnabled } = req.body as {
      maxMessagesPerConversation?: number;
      archiveAfterDaysInactive?: number;
      autoCleanupEnabled?: boolean;
    };

    await cleanup.saveConfig({
      maxMessagesPerConversation,
      archiveAfterDaysInactive,
      autoCleanupEnabled,
    });

    const updated = await cleanup.loadConfig();
    res.json(createApiResponse(updated));
  } catch (error) {
    next(error);
  }
});

chatRouter.post("/cleanup/run", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const logger = req.app.locals["logger"] || console;
    const cleanup = new ChatCleanupService(db, logger as any);
    const result = await cleanup.runGlobalCleanup();
    res.json(createApiResponse(result));
  } catch (error) {
    next(error);
  }
});

