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
 *
 * Das Sende-Intervall ist konfigurierbar (Default 3 Min., Minimum 1 Min.) -- dafuer laeuft
 * intern ein kurzer Poll-Tick (30s), der nur tatsaechlich sendet, wenn seit dem letzten Senden
 * mindestens das konfigurierte Intervall vergangen ist. So wirkt eine Intervall-Aenderung sofort,
 * ohne den Service neu starten zu muessen (gleiches Muster wie CloudBackupScheduler).
 */

import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { getConnectionStatus, sendHeartbeat, reportCommandResult, CloudSyncError } from "./cloud-sync.js";
import { isCloudControlEnabled, gatherStateSnapshot, dispatchCommand, type CloudControlDeps } from "./cloud-control.js";

export const SETTING_HEARTBEAT_INTERVAL_MINUTES = "CLOUD_HEARTBEAT_INTERVAL_MINUTES";
export const DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 3;
export const MIN_HEARTBEAT_INTERVAL_MINUTES = 1;

const POLL_INTERVAL_MS = 30 * 1000;

export class CloudHeartbeatService {
  private timer?: NodeJS.Timeout;
  private lastSentAt = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger,
    private readonly controlDeps: CloudControlDeps
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
    this.logger.info("Cloud-Heartbeat-Service gestartet", { pollIntervalMs: POLL_INTERVAL_MS });
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async getIntervalMs(): Promise<number> {
    const raw = await this.db.getSetting(SETTING_HEARTBEAT_INTERVAL_MINUTES);
    const parsed = raw ? Number(raw) : NaN;
    const minutes =
      Number.isFinite(parsed) && parsed >= MIN_HEARTBEAT_INTERVAL_MINUTES ? parsed : DEFAULT_HEARTBEAT_INTERVAL_MINUTES;
    return minutes * 60_000;
  }

  private async tick(): Promise<void> {
    try {
      const status = await getConnectionStatus(this.db);
      if (!status.connected) return;

      const intervalMs = await this.getIntervalMs();
      if (Date.now() - this.lastSentAt < intervalMs) return;
      this.lastSentAt = Date.now();

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
