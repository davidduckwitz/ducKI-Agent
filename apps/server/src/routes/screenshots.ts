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

  res.setHeader("Content-Type", manager.getScreenshotMimeType(id));
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(buffer);
});

/**
 * POST /api/screenshots/:id/download
 * Download a screenshot with filename
 */
screenshotRouter.post("/:id/download", async (req, res) => {
  const { id } = req.params;

  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Invalid screenshot ID" });
  }

  const manager = getScreenshotStorageManager();
  const buffer = await manager.getScreenshot(id);

  if (!buffer) {
    return res.status(404).json({ error: "Screenshot not found or expired" });
  }

  const mimeType = manager.getScreenshotMimeType(id);
  const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `screenshot-${timestamp}.${extension}`;

  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-cache");
  res.send(buffer);
});
