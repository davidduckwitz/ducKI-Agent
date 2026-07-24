import { Router, type IRouter } from "express";
import type { Agent } from "@ducki/agent";
import { dynamicToolRowToDefinition, loadToolManifests, isToolActive, parseEnabledToolNamesSetting } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse } from "@ducki/shared";

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

