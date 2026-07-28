import type { Router } from "express";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import { ProviderSettingsService } from "../lib/provider-settings-service.js";

/**
 * Provider Settings API Routes
 * Endpoints for reading, updating, and resetting provider configuration
 */
export function registerProviderSettingsRoutes(router: Router, db: DatabaseService): void {
  const logger = getRootLogger().child("ProviderSettingsAPI");
  const settingsService = new ProviderSettingsService(db);

  /**
   * GET /api/settings/agent-provider
   * Get current provider settings
   */
  router.get("/settings/agent-provider", async (_req, res) => {
    try {
      const settings = await settingsService.getSettings();
      res.json({
        success: true,
        data: settings,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Failed to get settings", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: "Failed to get provider settings",
      });
    }
  });

  /**
   * GET /api/settings/agent-provider/flat
   * Get settings as flat key-value pairs (useful for forms)
   */
  router.get("/settings/agent-provider/flat", async (_req, res) => {
    try {
      const settings = await settingsService.getSettingsFlat();
      res.json({
        success: true,
        data: settings,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Failed to get flat settings", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: "Failed to get provider settings",
      });
    }
  });

  /**
   * POST /api/settings/agent-provider
   * Create/initialize provider settings
   * Body: partial ProviderSettings object
   */
  router.post("/settings/agent-provider", async (req, res) => {
    try {
      const partial = req.body;

      if (!partial || typeof partial !== "object") {
        return res.status(400).json({
          success: false,
          error: "Request body must be an object",
        });
      }

      const updated = await settingsService.updateSettings(partial);

      res.status(201).json({
        success: true,
        data: updated,
        message: "Provider settings updated",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Failed to update settings", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to update provider settings",
      });
    }
  });

  /**
   * PATCH /api/settings/agent-provider
   * Update specific provider setting
   * Body: { path: "errorClassifier.maxRetryAttempts", value: 5 }
   */
  router.patch("/settings/agent-provider", async (req, res) => {
    try {
      const { path, value } = req.body;

      if (!path || typeof path !== "string") {
        return res.status(400).json({
          success: false,
          error: "path must be a string",
        });
      }

      if (value === undefined) {
        return res.status(400).json({
          success: false,
          error: "value must be provided",
        });
      }

      const updated = await settingsService.updateSetting(path, value);

      res.json({
        success: true,
        data: updated,
        message: `Updated ${path}`,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Failed to update setting", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to update setting",
      });
    }
  });

  /**
   * DELETE /api/settings/agent-provider
   * Reset provider settings to defaults (removes from DB, uses env vars)
   */
  router.delete("/settings/agent-provider", async (_req, res) => {
    try {
      const defaults = await settingsService.resetToDefaults();

      res.json({
        success: true,
        data: defaults,
        message: "Provider settings reset to defaults",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Failed to reset settings", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: "Failed to reset provider settings",
      });
    }
  });

  /**
   * POST /api/settings/agent-provider/export
   * Export settings as JSON (for backup/download)
   */
  router.post("/settings/agent-provider/export", async (_req, res) => {
    try {
      const json = await settingsService.exportSettings();

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", "attachment; filename=provider-settings.json");
      res.send(json);
    } catch (error) {
      logger.error("Failed to export settings", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: "Failed to export provider settings",
      });
    }
  });

  /**
   * POST /api/settings/agent-provider/import
   * Import settings from JSON (for restore/upload)
   * Body: raw JSON string or Buffer
   */
  router.post("/settings/agent-provider/import", async (req, res) => {
    try {
      let json: string;

      if (typeof req.body === "string") {
        json = req.body;
      } else if (Buffer.isBuffer(req.body)) {
        json = req.body.toString("utf8");
      } else {
        json = JSON.stringify(req.body);
      }

      const imported = await settingsService.importSettings(json);

      res.json({
        success: true,
        data: imported,
        message: "Provider settings imported",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Failed to import settings", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to import provider settings",
      });
    }
  });

  logger.info("Provider Settings API routes registered");
}
