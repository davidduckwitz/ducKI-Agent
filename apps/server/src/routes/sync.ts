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
  restoreLatestBackup,
} from "../lib/cloud-sync.js";

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
    const result = await restoreLatestBackup(db(req));
    res.json(createApiResponse(result));
  } catch (error) {
    handleError(res, error);
  }
});
