import { Router, type IRouter } from "express";
import type { Agent } from "@ducki/agent";
import { dynamicToolRowToDefinition } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse } from "@ducki/shared";

export const toolsRouter: IRouter = Router();

toolsRouter.get("/", async (req, res, next) => {
  try {
    const agent = req.app.locals["agent"] as Agent;
    const db = req.app.locals["db"] as DatabaseService;
    const staticDefinitions = agent.executor.getToolDefinitions();
    const dynamicRows = await db.listDynamicTools();
    const dynamicDefinitions = dynamicRows.map((row) => dynamicToolRowToDefinition(row));
    res.json(createApiResponse([...staticDefinitions, ...dynamicDefinitions]));
  } catch (error) {
    next(error);
  }
});

