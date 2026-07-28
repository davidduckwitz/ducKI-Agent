import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import { createProviderSettings, type ProviderSettings } from "@ducki/agent";

const SETTINGS_KEY = "provider_settings:agent";

/**
 * Service for managing Provider Settings persistence
 * Uses the existing settings table with a namespaced key
 */
export class ProviderSettingsService {
  private logger: Logger;

  constructor(private readonly db: DatabaseService) {
    this.logger = getRootLogger().child("ProviderSettingsService");
  }

  /**
   * Get current provider settings from database
   * Falls back to environment variables if not in database
   */
  async getSettings(): Promise<ProviderSettings> {
    try {
      const stored = await this.db.getSetting(SETTINGS_KEY);

      if (stored) {
        const parsed = JSON.parse(stored);
        this.logger.debug("Loaded provider settings from database");
        return parsed as ProviderSettings;
      }
    } catch (error) {
      this.logger.warn("Failed to load settings from database, using env vars", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Fall back to environment variables
    return createProviderSettings();
  }

  /**
   * Update provider settings in database
   * Validates settings before saving
   */
  async updateSettings(partial: Partial<ProviderSettings>): Promise<ProviderSettings> {
    try {
      // Get current settings
      const current = await this.getSettings();

      // Merge with new settings
      const updated = {
        ...current,
        ...partial,
      };

      // Save to database
      const json = JSON.stringify(updated, null, 2);
      await this.db.setSetting(SETTINGS_KEY, json);

      this.logger.info("Provider settings updated", {
        keys: Object.keys(partial),
      });

      return updated;
    } catch (error) {
      this.logger.error("Failed to update settings", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to update provider settings: ${error}`);
    }
  }

  /**
   * Update a single setting value
   */
  async updateSetting(path: string, value: unknown): Promise<ProviderSettings> {
    const current = await this.getSettings();
    const updated = this.setNestedValue(current, path, value);
    return this.updateSettings(updated);
  }

  /**
   * Reset settings to defaults (removes from database)
   * Will use env vars on next load
   */
  async resetToDefaults(): Promise<ProviderSettings> {
    try {
      await this.db.deleteSetting(SETTINGS_KEY);
      this.logger.info("Provider settings reset to defaults");
      return createProviderSettings();
    } catch (error) {
      this.logger.error("Failed to reset settings", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to reset provider settings: ${error}`);
    }
  }

  /**
   * Export settings as JSON
   */
  async exportSettings(): Promise<string> {
    const settings = await this.getSettings();
    return JSON.stringify(settings, null, 2);
  }

  /**
   * Import settings from JSON
   */
  async importSettings(json: string): Promise<ProviderSettings> {
    try {
      const parsed = JSON.parse(json);
      return this.updateSettings(parsed);
    } catch (error) {
      this.logger.error("Failed to import settings", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Invalid settings JSON: ${error}`);
    }
  }

  /**
   * Get settings as a flat object for API response
   */
  async getSettingsFlat(): Promise<Record<string, unknown>> {
    const settings = await this.getSettings();
    return this.flattenObject(settings);
  }

  /**
   * Helper: Set nested value in object
   */
  private setNestedValue(obj: Record<string, any>, path: string, value: unknown): Partial<ProviderSettings> {
    const keys = path.split(".");
    const result = { ...obj };
    let current = result;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i]!;
      if (!(key in current)) {
        current[key] = {};
      }
      current = current[key];
    }

    const lastKey = keys[keys.length - 1]!;
    current[lastKey] = value;
    return result;
  }

  /**
   * Helper: Flatten nested object for API response
   */
  private flattenObject(obj: Record<string, any>, prefix = ""): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const key in obj) {
      const value = obj[key];
      const newKey = prefix ? `${prefix}.${key}` : key;

      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(result, this.flattenObject(value, newKey));
      } else {
        result[newKey] = value;
      }
    }

    return result;
  }
}
