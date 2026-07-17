import { Router, type IRouter } from "express";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse } from "@ducki/shared";

export const logsRouter: IRouter = Router();

logsRouter.get("/", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const level = req.query["level"] as string | undefined;
    const limit = req.query["limit"] ? parseInt(req.query["limit"] as string) : 100;
    res.json(createApiResponse(await db.getLogs(level, limit)));
  } catch (e) { next(e); }
});


