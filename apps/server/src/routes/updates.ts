import { Router, type IRouter } from "express";
import { createApiResponse } from "@ducki/shared";
import type { UpdateManager } from "../lib/update-manager.js";

export const updatesRouter: IRouter = Router();

updatesRouter.get("/status", (req, res) => {
  const manager = req.app.locals["updateManager"] as UpdateManager | undefined;
  if (!manager) {
    res.json(createApiResponse({
      enabled: false,
      configured: false,
      checking: false,
      updating: false,
      updateAvailable: false,
      lastUpdateOutput: [],
    }));
    return;
  }

  res.json(createApiResponse(manager.snapshot()));
});

updatesRouter.post("/check", async (req, res, next) => {
  try {
    const manager = req.app.locals["updateManager"] as UpdateManager | undefined;
    if (!manager) {
      res.json(createApiResponse({
        enabled: false,
        configured: false,
        checking: false,
        updating: false,
        updateAvailable: false,
        lastUpdateOutput: [],
      }));
      return;
    }

    const status = await manager.checkForUpdates();
    res.json(createApiResponse(status));
  } catch (error) {
    next(error);
  }
});

updatesRouter.post("/start", async (req, res, next) => {
  try {
    const manager = req.app.locals["updateManager"] as UpdateManager | undefined;
    if (!manager) {
      res.json(createApiResponse({
        enabled: false,
        configured: false,
        checking: false,
        updating: false,
        updateAvailable: false,
        lastUpdateOutput: [],
      }));
      return;
    }

    const status = await manager.startUpdate();
    res.json(createApiResponse(status));
  } catch (error) {
    next(error);
  }
});
