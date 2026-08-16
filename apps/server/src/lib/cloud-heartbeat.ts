/**
 * Periodisches Lebenszeichen an die Cloud, solange eine Verbindung besteht (siehe
 * cloud-sync.ts connect()/getConnectionStatus()). Anders als geplante Backups gibt es hier
 * keinen separaten Ein/Aus-Schalter fuer den Ping selbst -- wer sich verbindet, erwartet, dass
 * das Dashboard seinen Online-Status zeigt. Es werden nur Geraetename und Agent-Version
 * uebertragen.
 *
 * Zusaetzlich traegt dieser Service "Cloud Control": nur wenn CLOUD_CONTROL_ENABLED lokal aktiv
 * ist (siehe cloud-control.ts, Default AUS), wird ein Zustands-Spiegel mitgeschickt und werden
 * vom Server ausgelieferte Befehle abgeholt, lokal ausgefuehrt und das Ergebnis zurueckgemeldet.
 */

import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { getConnectionStatus, sendHeartbeat, reportCommandResult, CloudSyncError } from "./cloud-sync.js";
import { isCloudControlEnabled, gatherStateSnapshot, dispatchCommand, type CloudControlDeps } from "./cloud-control.js";

const INTERVAL_MS = 3 * 60 * 1000;

export class CloudHeartbeatService {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger,
    private readonly controlDeps: CloudControlDeps
  ) {}

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

      const controlEnabled = await isCloudControlEnabled(this.db);
      const stateSnapshot = controlEnabled ? await gatherStateSnapshot(this.controlDeps) : undefined;

      const pendingCommands = await sendHeartbeat(this.db, {
        stateSnapshot: stateSnapshot as unknown as Record<string, unknown> | undefined,
      });

      if (!controlEnabled || pendingCommands.length === 0) return;

      for (const command of pendingCommands) {
        this.logger.info("Fuehre Cloud-Control-Befehl aus", { commandId: command.id, type: command.type });
        const outcome = await dispatchCommand(this.controlDeps, command);
        try {
          await reportCommandResult(this.db, command.id, outcome.status, outcome.result);
        } catch (reportError) {
          this.logger.error("Konnte Befehlsergebnis nicht melden", {
            commandId: command.id,
            error: reportError instanceof Error ? reportError.message : String(reportError),
          });
        }
      }
    } catch (error) {
      if (error instanceof CloudSyncError) {
        this.logger.debug("Heartbeat fehlgeschlagen", { error: error.message });
        return;
      }
      this.logger.error("Heartbeat fehlgeschlagen", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
