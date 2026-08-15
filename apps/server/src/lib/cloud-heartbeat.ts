/**
 * Periodisches Lebenszeichen an die Cloud, solange eine Verbindung besteht (siehe
 * cloud-sync.ts connect()/getConnectionStatus()). Anders als geplante Backups gibt es hier
 * keinen separaten Ein/Aus-Schalter -- wer sich verbindet, erwartet, dass das Dashboard seinen
 * Online-Status zeigt. Es werden nur Geraetename und Agent-Version uebertragen.
 */

import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { getConnectionStatus, sendHeartbeat, CloudSyncError } from "./cloud-sync.js";

const INTERVAL_MS = 5 * 60 * 1000;

export class CloudHeartbeatService {
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: DatabaseService, private readonly logger: Logger) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, INTERVAL_MS);
    this.logger.info("Cloud-Heartbeat-Service gestartet", { intervalMs: INTERVAL_MS });
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    try {
      const status = await getConnectionStatus(this.db);
      if (!status.connected) return;
      await sendHeartbeat(this.db);
    } catch (error) {
      if (error instanceof CloudSyncError) {
        this.logger.debug("Heartbeat fehlgeschlagen", { error: error.message });
        return;
      }
      this.logger.error("Heartbeat fehlgeschlagen", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
