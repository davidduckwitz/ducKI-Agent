import { Router, type IRouter } from "express";
import type { Agent } from "@ducki/agent";
import { createApiResponse } from "@ducki/shared";

export const toolsRouter: IRouter = Router();

toolsRouter.get("/", (req, res) => {
  const agent = req.app.locals["agent"] as Agent;
  res.json(createApiResponse(agent.executor.listTools()));
});

