import { Router, type IRouter } from "express";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse } from "@ducki/shared";

export const settingsRouter: IRouter = Router();

const PROVIDER_SETTINGS = new Set([
  "DEFAULT_PROVIDER",
  "LM_STUDIO_BASE_URL",
  "LM_STUDIO_MODEL",
  "LM_STUDIO_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_MODEL",
  "OPENROUTER_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
]);

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
    const key = String(req.params["key"] ?? "");
    const { value } = req.body as { value: string };
    await (req.app.locals["db"] as DatabaseService).setSetting(key, value);

    let providerReloaded: string | undefined;
    if (PROVIDER_SETTINGS.has(key)) {
      const reloadProvider = req.app.locals["reloadProvider"] as undefined | (() => Promise<string | undefined>);
      if (reloadProvider) {
        providerReloaded = await reloadProvider();
      }
    }

    res.json(createApiResponse({ updated: true, providerReloaded }));
  } catch (e) { next(e); }
});


