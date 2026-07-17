import { Router, type IRouter } from "express";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse } from "@ducki/shared";

export const settingsRouter: IRouter = Router();

settingsRouter.get("/", async (req, res, next) => {
  try { res.json(createApiResponse(await (req.app.locals["db"] as DatabaseService).getAllSettings())); } catch (e) { next(e); }
});

settingsRouter.get("/:key", async (req, res, next) => {
  try {
    const value = await (req.app.locals["db"] as DatabaseService).getSetting(req.params["key"] ?? "");
    res.json(createApiResponse({ key: req.params["key"], value }));
  } catch (e) { next(e); }
});

settingsRouter.put("/:key", async (req, res, next) => {
  try {
    const { value } = req.body as { value: string };
    await (req.app.locals["db"] as DatabaseService).setSetting(req.params["key"] ?? "", value);
    res.json(createApiResponse({ updated: true }));
  } catch (e) { next(e); }
});


