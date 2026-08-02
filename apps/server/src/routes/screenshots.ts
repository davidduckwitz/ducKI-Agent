import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import { getScreenshotStorageManager } from "../lib/screenshot-storage.js";

export const screenshotRouter: ExpressRouter = Router();

/**
 * GET /api/screenshots/:id
 * Retrieve a stored screenshot by ID
 */
screenshotRouter.get("/:id", async (req, res) => {
  const { id } = req.params;

  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Invalid screenshot ID" });
  }

  const manager = getScreenshotStorageManager();
  const buffer = await manager.getScreenshot(id);

  if (!buffer) {
    return res.status(404).json({ error: "Screenshot not found or expired" });
  }

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(buffer);
});
