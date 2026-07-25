import { Router, type IRouter } from "express";
import type { Agent } from "@ducki/agent";
import { dynamicToolRowToDefinition, loadToolManifests, isToolActive, parseEnabledToolNamesSetting } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse, createApiError } from "@ducki/shared";

export const toolsRouter: IRouter = Router();

toolsRouter.get("/", async (req, res, next) => {
  try {
    const agent = req.app.locals["agent"] as Agent;
    const db = req.app.locals["db"] as DatabaseService;

    const toolManifests = loadToolManifests();
    const enabledOptionalTools = new Set(parseEnabledToolNamesSetting(await db.getSetting("ENABLED_OPTIONAL_TOOLS")));
    const manifestByName = new Map(toolManifests.map((manifest) => [manifest.name, manifest]));

    const staticDefinitions = agent.executor.getToolDefinitions().map((definition) => ({
      ...definition,
      core: manifestByName.get(definition.name)?.core ?? true,
      enabled: isToolActive(definition.name, toolManifests, enabledOptionalTools),
      subagent: manifestByName.get(definition.name)?.subagent ?? false,
    }));

    const dynamicRows = await db.listDynamicTools();
    const dynamicDefinitions = dynamicRows.map((row) => ({
      ...dynamicToolRowToDefinition(row),
      core: false,
      enabled: Boolean(row.enabled),
      subagent: false,
    }));

    res.json(createApiResponse([...staticDefinitions, ...dynamicDefinitions]));
  } catch (error) {
    next(error);
  }
});

/**
 * Runs a single tool directly from the chat UI's "/" tool selector, bypassing the LLM
 * entirely. Uses a fresh agent instance (via createAgent) rather than the shared
 * app.locals["agent"] singleton, matching the pattern already used for websocket chat -
 * each Agent instance carries its own loaded-conversation state, so reusing the singleton
 * here could race with an in-flight chat run on the same instance.
 */
toolsRouter.post("/execute", async (req, res, next) => {
  try {
    const createAgent = req.app.locals["createAgent"] as () => Agent;
    const body = req.body as { toolName?: string; input?: Record<string, unknown>; conversationId?: number };
    const toolName = String(body.toolName ?? "").trim();
    if (!toolName) {
      res.status(400).json(createApiError("toolName is required"));
      return;
    }

    const agent = createAgent();
    if (body.conversationId) {
      await agent.loadConversation(body.conversationId);
    }

    const result = await agent.executeToolDirect(toolName, body.input ?? {});
    res.json(createApiResponse(result));
  } catch (error) {
    next(error);
  }
});

