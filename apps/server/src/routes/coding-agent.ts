import { Router, type IRouter } from "express";
import type { CodingAgent } from "@ducki/agent";
import type { DatabaseService } from "@ducki/database";
import { createApiError, createApiResponse } from "@ducki/shared";

export const codingAgentRouter: IRouter = Router();

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

codingAgentRouter.use(async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const raw = await db.getSetting("CODING_ENABLED");
    const enabled = parseBoolean(raw ?? "false", false);
    if (!enabled) {
      res.status(403).json(createApiError("Coding area is disabled"));
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
});

codingAgentRouter.post("/run", async (req, res, next) => {
  try {
    const createCodingAgent = req.app.locals["createCodingAgent"] as
      | ((options?: { sandboxRoot?: string }) => CodingAgent)
      | undefined;
    if (!createCodingAgent) {
      res.status(500).json(createApiError("Coding agent factory is not configured"));
      return;
    }

    const body = (req.body ?? {}) as { goal?: string; verifyCommand?: string; sandboxRoot?: string; maxAttempts?: number };
    const goal = String(body.goal ?? "").trim();
    if (!goal) {
      res.status(400).json(createApiError("goal is required"));
      return;
    }

    const codingAgent = createCodingAgent({ sandboxRoot: body.sandboxRoot });
    const result = await codingAgent.run(goal, {
      verifyCommand: body.verifyCommand,
      maxAttempts: body.maxAttempts,
    });

    res.json(createApiResponse(result));
  } catch (error) {
    next(error);
  }
});
