import { Router, type IRouter } from "express";
import { createApiResponse, createApiError } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";

export const pendingWritesRouter: IRouter = Router();

function getDb(req: import("express").Request): DatabaseService {
  return req.app.locals["db"] as DatabaseService;
}

/** GET /api/pending-writes - list all pending (unapproved, unrejected) writes */
pendingWritesRouter.get("/", async (req, res, next) => {
  try {
    const db = getDb(req);
    const typeFilter = req.query["type"] as string | undefined;
    const writes = await db.listPendingWrites(typeFilter ? { type: typeFilter } : undefined);
    res.json(createApiResponse(writes));
  } catch (error) {
    next(error);
  }
});

/** POST /api/pending-writes/:id/approve */
pendingWritesRouter.post("/:id/approve", async (req, res, next) => {
  try {
    const db = getDb(req);
    const id = parseInt(req.params["id"] ?? "0", 10);
    if (!id) {
      res.status(400).json(createApiError("Invalid id"));
      return;
    }
    await db.approvePendingWrite(id);
    res.json(createApiResponse({ approved: true, id }));
  } catch (error) {
    next(error);
  }
});

/** POST /api/pending-writes/:id/reject */
pendingWritesRouter.post("/:id/reject", async (req, res, next) => {
  try {
    const db = getDb(req);
    const id = parseInt(req.params["id"] ?? "0", 10);
    if (!id) {
      res.status(400).json(createApiError("Invalid id"));
      return;
    }
    await db.rejectPendingWrite(id);
    res.json(createApiResponse({ rejected: true, id }));
  } catch (error) {
    next(error);
  }
});

/** POST /api/pending-writes/approve-all - approve all pending writes */
pendingWritesRouter.post("/approve-all", async (req, res, next) => {
  try {
    const db = getDb(req);
    const writes = await db.listPendingWrites();
    for (const w of writes) {
      await db.approvePendingWrite(w.id);
    }
    res.json(createApiResponse({ approved: writes.length }));
  } catch (error) {
    next(error);
  }
});

/** POST /api/pending-writes/reject-all - reject all pending writes */
pendingWritesRouter.post("/reject-all", async (req, res, next) => {
  try {
    const db = getDb(req);
    const writes = await db.listPendingWrites();
    for (const w of writes) {
      await db.rejectPendingWrite(w.id);
    }
    res.json(createApiResponse({ rejected: writes.length }));
  } catch (error) {
    next(error);
  }
});