/**
 * Cloud-Backup/-Restore fuer selbstgehostete (BYO) Agenten. Duenne HTTP-Schicht ueber
 * `../lib/cloud-sync.ts` — siehe dort fuer die eigentliche Logik (Snapshot, Upload, Restore).
 */

import { Router, type IRouter } from "express";
import type { DatabaseService } from "@ducki/database";
import { createApiResponse, createApiError } from "@ducki/shared";
import {
  CloudSyncError,
  connect,
  disconnect,
  getConnectionStatus,
  listBackups,
  createBackup,
  restoreBackup,
} from "../lib/cloud-sync.js";
import {
  SETTING_SCHEDULE_ENABLED,
  SETTING_SCHEDULE_INTERVAL_HOURS,
  SETTING_SCHEDULE_LAST_RUN_AT,
  DEFAULT_INTERVAL_HOURS,
} from "../lib/cloud-backup-scheduler.js";

export const syncRouter: IRouter = Router();

function db(req: import("express").Request): DatabaseService {
  return req.app.locals["db"] as DatabaseService;
}

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof CloudSyncError) {
    res.status(error.status ?? 502).json(createApiError(error.message));
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json(createApiError(message));
}

syncRouter.get("/status", async (req, res) => {
  try {
    res.json(createApiResponse(await getConnectionStatus(db(req))));
  } catch (error) {
    handleError(res, error);
  }
});

syncRouter.post("/connect", async (req, res) => {
  try {
    const { apiKey, baseUrl } = req.body as { apiKey?: string; baseUrl?: string };
    if (!apiKey?.trim()) {
      res.status(400).json(createApiError("apiKey ist erforderlich"));
      return;
    }
    await connect(db(req), apiKey, baseUrl);
    res.json(createApiResponse(await getConnectionStatus(db(req))));
  } catch (error) {
    handleError(res, error);
  }
});

syncRouter.post("/disconnect", async (req, res) => {
  try {
    await disconnect(db(req));
    res.json(createApiResponse({ connected: false }));
  } catch (error) {
    handleError(res, error);
  }
});

syncRouter.get("/backups", async (req, res) => {
  try {
    res.json(createApiResponse(await listBackups(db(req))));
  } catch (error) {
    handleError(res, error);
  }
});

syncRouter.post("/backup", async (req, res) => {
  try {
    const { deviceName } = (req.body ?? {}) as { deviceName?: string };
    const result = await createBackup(db(req), { deviceName });
    res.status(201).json(createApiResponse(result));
  } catch (error) {
    handleError(res, error);
  }
});

syncRouter.post("/restore", async (req, res) => {
  try {
    const { backupId } = (req.body ?? {}) as { backupId?: number };
    const result = await restoreBackup(db(req), { backupId });
    res.json(createApiResponse(result));
  } catch (error) {
    handleError(res, error);
  }
});

syncRouter.get("/schedule", async (req, res) => {
  try {
    const database = db(req);
    const [enabledRaw, intervalRaw, lastRunAt] = await Promise.all([
      database.getSetting(SETTING_SCHEDULE_ENABLED),
      database.getSetting(SETTING_SCHEDULE_INTERVAL_HOURS),
      database.getSetting(SETTING_SCHEDULE_LAST_RUN_AT),
    ]);
    const intervalHours = intervalRaw ? Number(intervalRaw) : NaN;
    res.json(
      createApiResponse({
        enabled: enabledRaw === "true",
        intervalHours: Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : DEFAULT_INTERVAL_HOURS,
        lastRunAt: lastRunAt ?? null,
      })
    );
  } catch (error) {
    handleError(res, error);
  }
});

syncRouter.put("/schedule", async (req, res) => {
  try {
    const { enabled, intervalHours } = req.body as { enabled?: boolean; intervalHours?: number };
    const database = db(req);
    if (typeof enabled === "boolean") {
      await database.setSetting(SETTING_SCHEDULE_ENABLED, enabled ? "true" : "false");
    }
    if (typeof intervalHours === "number" && Number.isFinite(intervalHours) && intervalHours > 0) {
      await database.setSetting(SETTING_SCHEDULE_INTERVAL_HOURS, String(intervalHours));
    }
    res.json(createApiResponse({ ok: true }));
  } catch (error) {
    handleError(res, error);
  }
});
