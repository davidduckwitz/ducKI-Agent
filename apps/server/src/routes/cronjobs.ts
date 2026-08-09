import { Router, type IRouter } from "express";
import { createApiError, createApiResponse } from "@ducki/shared";
import { isCronExpressionValid, type DatabaseService } from "@ducki/database";
import type { CronjobManager } from "../lib/cronjob-manager.js";

export const cronjobsRouter: IRouter = Router();

/** Supported cronjob target kinds. */
const CRON_TARGET_TYPES = ["task", "prompt", "tool", "skill", "workflow", "coding"] as const;
type CronTargetType = (typeof CRON_TARGET_TYPES)[number];

function toEnabled(value: unknown): number {
  if (value === false || value === 0 || value === "0") return 0;
  return 1;
}

cronjobsRouter.get("/", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const jobs = await db.listCronJobs();
    res.json(createApiResponse(jobs));
  } catch (error) {
    next(error);
  }
});

cronjobsRouter.get("/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const id = Number.parseInt(req.params["id"] ?? "", 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(createApiError("Invalid cronjob id"));
      return;
    }

    const job = await db.getCronJob(id);
    if (!job) {
      res.status(404).json(createApiError("Cronjob not found"));
      return;
    }

    res.json(createApiResponse(job));
  } catch (error) {
    next(error);
  }
});

cronjobsRouter.post("/", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const body = req.body as {
      name?: string;
      schedule?: string;
      targetType?: CronTargetType;
      targetRef?: string;
      payload?: unknown;
      enabled?: boolean;
      runAt?: string;
      runOnce?: boolean;
    };

    const name = body.name?.trim();
    const schedule = body.schedule?.trim();
    const targetType = body.targetType;

    if (!name) {
      res.status(400).json(createApiError("name is required"));
      return;
    }

    if (!schedule || !isCronExpressionValid(schedule)) {
      res.status(400).json(createApiError("Valid cron schedule is required (minute hour day month weekday)"));
      return;
    }

    if (!targetType || !CRON_TARGET_TYPES.includes(targetType)) {
      res.status(400).json(createApiError(`targetType must be one of: ${CRON_TARGET_TYPES.join(", ")}`));
      return;
    }

    // targetRef identifies the concrete thing to run. Coding accepts a goal via payload instead.
    if (["task", "tool", "skill", "workflow"].includes(targetType) && !body.targetRef?.trim()) {
      res.status(400).json(createApiError("targetRef is required for task, tool, skill, and workflow cronjobs"));
      return;
    }

    const runAt = body.runAt?.trim();
    if (runAt && Number.isNaN(Date.parse(runAt))) {
      res.status(400).json(createApiError("runAt must be an ISO date-time"));
      return;
    }

    const created = await db.createCronJob({
      name,
      schedule,
      targetType,
      targetRef: body.targetRef?.trim() || null,
      payload: body.payload !== undefined ? JSON.stringify(body.payload) : null,
      enabled: toEnabled(body.enabled),
      runAt: runAt || null,
      runOnce: body.runOnce ? 1 : 0,
    });

    res.status(201).json(createApiResponse(created));
  } catch (error) {
    next(error);
  }
});

cronjobsRouter.patch("/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const id = Number.parseInt(req.params["id"] ?? "", 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(createApiError("Invalid cronjob id"));
      return;
    }

    const body = req.body as {
      name?: string;
      schedule?: string;
      targetType?: CronTargetType;
      targetRef?: string | null;
      payload?: unknown;
      enabled?: boolean;
      runAt?: string | null;
      runOnce?: boolean;
    };

    if (body.schedule !== undefined && !isCronExpressionValid(String(body.schedule))) {
      res.status(400).json(createApiError("Invalid cron schedule"));
      return;
    }

    if (body.targetType !== undefined && !CRON_TARGET_TYPES.includes(body.targetType)) {
      res.status(400).json(createApiError(`targetType must be one of: ${CRON_TARGET_TYPES.join(", ")}`));
      return;
    }

    if (typeof body.runAt === "string" && body.runAt.trim() && Number.isNaN(Date.parse(body.runAt))) {
      res.status(400).json(createApiError("runAt must be an ISO date-time"));
      return;
    }

    const updated = await db.updateCronJob(id, {
      name: body.name?.trim(),
      schedule: body.schedule?.trim(),
      targetType: body.targetType,
      targetRef: body.targetRef === null ? null : body.targetRef?.trim(),
      payload: body.payload !== undefined ? JSON.stringify(body.payload) : undefined,
      enabled: body.enabled === undefined ? undefined : toEnabled(body.enabled),
      runAt: body.runAt === null ? null : body.runAt?.trim(),
      runOnce: body.runOnce === undefined ? undefined : body.runOnce ? 1 : 0,
    });

    if (!updated) {
      res.status(404).json(createApiError("Cronjob not found"));
      return;
    }

    res.json(createApiResponse(updated));
  } catch (error) {
    next(error);
  }
});

cronjobsRouter.delete("/:id", async (req, res, next) => {
  try {
    const db = req.app.locals["db"] as DatabaseService;
    const id = Number.parseInt(req.params["id"] ?? "", 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(createApiError("Invalid cronjob id"));
      return;
    }

    await db.deleteCronJob(id);
    res.json(createApiResponse({ deleted: true }));
  } catch (error) {
    next(error);
  }
});

cronjobsRouter.post("/:id/run", async (req, res, next) => {
  try {
    const manager = req.app.locals["cronjobManager"] as CronjobManager;
    const id = Number.parseInt(req.params["id"] ?? "", 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json(createApiError("Invalid cronjob id"));
      return;
    }

    const job = await manager.runNow(id);
    if (!job) {
      res.status(404).json(createApiError("Cronjob not found"));
      return;
    }

    res.json(createApiResponse(job));
  } catch (error) {
    next(error);
  }
});
