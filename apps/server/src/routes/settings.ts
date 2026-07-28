import { Router, type IRouter } from "express";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse } from "@ducki/shared";
import { ProviderSettingsService } from "../lib/provider-settings-service.js";

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
  "CLAUDE_API_KEY",
  "CLAUDE_MODEL",
  "NOUS_API_KEY",
  "NOUS_BASE_URL",
  "NOUS_MODEL",
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

// ============================================================
// Provider Settings Routes
// ============================================================

settingsRouter.get("/agent-provider", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const service = new ProviderSettingsService(db);
    const settings = await service.getSettings();
    res.json(createApiResponse({ data: settings }));
  } catch (e) { next(e); }
});

settingsRouter.get("/agent-provider/flat", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const service = new ProviderSettingsService(db);
    const settings = await service.getSettingsFlat();
    res.json(createApiResponse({ data: settings }));
  } catch (e) { next(e); }
});

settingsRouter.post("/agent-provider", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const service = new ProviderSettingsService(db);
    const partial = req.body;
    const updated = await service.updateSettings(partial);
    res.status(201).json(createApiResponse({ data: updated, message: "Provider settings updated" }));
  } catch (e) { next(e); }
});

settingsRouter.patch("/agent-provider", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const service = new ProviderSettingsService(db);
    const { path, value } = req.body;

    if (!path || !value === undefined) {
      return res.status(400).json(createApiResponse({ error: "path and value are required" }));
    }

    const updated = await service.updateSetting(path, value);
    res.json(createApiResponse({ data: updated, message: `Updated ${path}` }));
  } catch (e) { next(e); }
});

settingsRouter.delete("/agent-provider", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const service = new ProviderSettingsService(db);
    const defaults = await service.resetToDefaults();
    res.json(createApiResponse({ data: defaults, message: "Settings reset to defaults" }));
  } catch (e) { next(e); }
});

settingsRouter.post("/agent-provider/export", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const service = new ProviderSettingsService(db);
    const json = await service.exportSettings();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=provider-settings.json");
    res.send(json);
  } catch (e) { next(e); }
});

settingsRouter.post("/agent-provider/import", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const service = new ProviderSettingsService(db);

    let json: string;
    if (typeof req.body === "string") {
      json = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      json = req.body.toString("utf8");
    } else {
      json = JSON.stringify(req.body);
    }

    const imported = await service.importSettings(json);
    res.json(createApiResponse({ data: imported, message: "Settings imported" }));
  } catch (e) { next(e); }
});

