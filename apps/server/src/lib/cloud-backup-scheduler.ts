/**
 * Optionale automatische Cloud-Backups. Bewusst standardmaessig AUS -- ein Nutzer muss den
 * Schalter aktiv in den Settings umlegen, bevor irgendetwas automatisch hochgeladen wird.
 * Prueft alle POLL_INTERVAL_MS, ob (a) die Funktion aktiviert ist, (b) eine Cloud-Verbindung
 * besteht und (c) seit dem letzten Lauf mehr als das konfigurierte Intervall vergangen ist --
 * nur dann wird ein Backup erstellt. Fehler brechen den Scheduler nicht ab, sie werden geloggt
 * und beim naechsten Tick erneut versucht.
 */

import { hostname } from "node:os";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { createBackup, getConnectionStatus } from "./cloud-sync.js";

export const SETTING_SCHEDULE_ENABLED = "CLOUD_BACKUP_SCHEDULE_ENABLED";
export const SETTING_SCHEDULE_INTERVAL_HOURS = "CLOUD_BACKUP_SCHEDULE_INTERVAL_HOURS";
export const SETTING_SCHEDULE_LAST_RUN_AT = "CLOUD_BACKUP_SCHEDULE_LAST_RUN_AT";
export const DEFAULT_INTERVAL_HOURS = 24;

const POLL_INTERVAL_MS = 15 * 60 * 1000;

export class CloudBackupScheduler {
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: DatabaseService, private readonly logger: Logger) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
    this.logger.info("Cloud-Backup-Scheduler gestartet (Poll-Intervall)", { pollIntervalMs: POLL_INTERVAL_MS });
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async isEnabled(): Promise<boolean> {
    return (await this.db.getSetting(SETTING_SCHEDULE_ENABLED)) === "true";
  }

  private async getIntervalHours(): Promise<number> {
    const raw = await this.db.getSetting(SETTING_SCHEDULE_INTERVAL_HOURS);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_HOURS;
  }

  private async tick(): Promise<void> {
    try {
      if (!(await this.isEnabled())) return;

      const status = await getConnectionStatus(this.db);
      if (!status.connected) return;

      const intervalHours = await this.getIntervalHours();
      const lastRunAt = await this.db.getSetting(SETTING_SCHEDULE_LAST_RUN_AT);
      const dueAtMs = lastRunAt ? new Date(lastRunAt).getTime() + intervalHours * 3600_000 : 0;
      if (Date.now() < dueAtMs) return;

      this.logger.info("Automatisches Cloud-Backup faellig, starte...", { intervalHours });
      const result = await createBackup(this.db, { deviceName: `${hostname()} (automatisch)` });
      await this.db.setSetting(SETTING_SCHEDULE_LAST_RUN_AT, new Date().toISOString());
      this.logger.info("Automatisches Cloud-Backup abgeschlossen", { backupId: result.backup.id });
    } catch (error) {
      this.logger.error("Automatisches Cloud-Backup fehlgeschlagen", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
