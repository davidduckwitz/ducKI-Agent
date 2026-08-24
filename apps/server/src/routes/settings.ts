import { Router, type IRouter } from "express";
import type { Request } from "express";
import type { Server as SocketIOServer } from "socket.io";
import type { DatabaseService } from "@ducki/database";
import { testMysqlConnection } from "@ducki/database";
import { createApiError, createApiResponse } from "@ducki/shared";
import { ProviderSettingsService } from "../lib/provider-settings-service.js";
import {
  AGENT_MODEL_PROFILES,
  applyAgentModelProfile,
  inferAgentModelProfile,
  parseAgentModelProfile,
} from "../lib/agent-model-profiles.js";
import { broadcastSettingsChanged } from "../websocket/index.js";

/**
 * Push the change instead of making every client poll for it. Four separate components
 * used to re-fetch the whole settings list every 5 seconds just to notice edits.
 */
function notifySettingsChanged(req: Request, keys?: string[]): void {
  const io = req.app.locals["io"] as SocketIOServer | undefined;
  if (io) broadcastSettingsChanged(io, keys);
}

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

// ============================================================
// Agent model-size profiles
// ============================================================

/**
 * Returns the centrally-defined presets plus the best-effort currently matching profile.
 * No capability switches are part of these presets; see agent-model-profiles.ts and its CI test.
 */
settingsRouter.get("/model-profile/presets", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const rows = await db.getAllSettings();
    const map = new Map(rows.map((row) => [row.key, row.value]));
    res.json(createApiResponse({
      currentProfile: inferAgentModelProfile(map),
      profiles: Object.values(AGENT_MODEL_PROFILES),
    }));
  } catch (e) { next(e); }
});

/**
 * Materialises one profile into the same DB settings Agent.loadRuntimeControls() reads at the
 * start of every run. This makes the WebUI authoritative without relying on process.env or a
 * server restart. Individual settings can still be fine-tuned afterwards; the UI then reports
 * the state as "custom" until it exactly matches a preset again.
 */
settingsRouter.post("/model-profile/apply", async (req, res, next) => {
  try {
    const profile = parseAgentModelProfile((req.body as { profile?: unknown } | undefined)?.profile);
    if (!profile) {
      res.status(400).json(createApiError("Unknown agent model profile. Use legacy, small, balanced or large."));
      return;
    }

    const db = req.app.locals["db"] as DatabaseService;
    const result = await applyAgentModelProfile(db, profile);
    notifySettingsChanged(req, result.appliedKeys);
    res.json(createApiResponse({
      ...result,
      definition: AGENT_MODEL_PROFILES[profile],
    }));
  } catch (e) { next(e); }
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

    notifySettingsChanged(req, [key]);
    res.json(createApiResponse({ updated: true, providerReloaded }));
  } catch (e) { next(e); }
});

// ============================================================
// Database connection test / inspection (MariaDB / MySQL)
// ============================================================

/**
 * Read-only connection test + table check for an external MariaDB/MySQL database. Delegates to the
 * database package's `testMysqlConnection` (which owns the mysql2 driver): it connects, reads the
 * server version and existing tables via information_schema, then disconnects. It runs ONLY SELECTs
 * and never touches the live SQLite database, so it is safe to call at any time. Failures are returned
 * as `{ ok: false, error }` with HTTP 200 so the UI can render them inline.
 */
settingsRouter.post("/database/test", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      engine?: string; url?: string;
      host?: string; port?: number | string; user?: string; password?: string; database?: string;
    };
    const engine = String(body.engine ?? "").toLowerCase();

    if (engine === "sqlite" || (typeof body.url === "string" && body.url.startsWith("file:"))) {
      res.json(createApiResponse({
        ok: true, engine: "sqlite",
        message: "SQLite is the built-in engine and always available - no external connection to test.",
        tables: null,
      }));
      return;
    }

    const result = await testMysqlConnection({
      host: String(body.host ?? ""),
      port: Number(body.port) || 3306,
      user: String(body.user ?? "root"),
      password: String(body.password ?? ""),
      database: String(body.database ?? ""),
    });
    res.json(createApiResponse({ engine: engine === "mariadb" ? "mariadb" : "mysql", ...result }));
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
    notifySettingsChanged(req);
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
    notifySettingsChanged(req, [String(path)]);
    res.json(createApiResponse({ data: updated, message: `Updated ${path}` }));
  } catch (e) { next(e); }
});

settingsRouter.delete("/agent-provider", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const service = new ProviderSettingsService(db);
    const defaults = await service.resetToDefaults();
    notifySettingsChanged(req);
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
    notifySettingsChanged(req);
    res.json(createApiResponse({ data: imported, message: "Settings imported" }));
  } catch (e) { next(e); }
});
