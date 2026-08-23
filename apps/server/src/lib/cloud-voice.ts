/**
 * "Voice-Chat" -- schneller Poll-Kanal fuer die im ducki-cloud-v1-Repo gehostete Voice-App,
 * damit sich ein Chat von unterwegs wie ein echtes Gespraech anfuehlt statt auf den traegen
 * Cloud-Control-Heartbeat (Default 3 Min., siehe cloud-heartbeat.ts) warten zu muessen.
 *
 * Bewusst ein SEPARATER Service statt eines kuerzeren Heartbeat-Intervalls: der Heartbeat
 * dient allen Cloud-Control-Befehlstypen UND dem Online-Status-Ping, ein global verkuerztes
 * Intervall wuerde jeden Nutzer treffen, auch ohne Voice-App. Dieser Dienst pollt NUR die
 * schnellen Voice-Befehlstypen (`chat.send`, `voice.transcribe` -- siehe RemoteControlService::
 * FAST_POLL_TYPES im Laravel-Repo, MUSS damit uebereinstimmen) und laeuft nur, wenn der Nutzer
 * ihn explizit zusaetzlich zu Cloud Control aktiviert (Default AUS, wie CLOUD_CONTROL_ENABLED).
 *
 * dispatchCommand() aus cloud-control.ts wird 1:1 wiederverwendet (beide Typen sind dort bereits
 * implementiert) -- keine doppelte Business-Logik.
 */

import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { getConnectionStatus, pollVoiceCommands, reportCommandResult, CloudSyncError } from "./cloud-sync.js";
import { isCloudControlEnabled, dispatchCommand, type CloudControlDeps } from "./cloud-control.js";

export const SETTING_VOICE_CHAT_ENABLED = "VOICE_CHAT_ENABLED";

/** Fest auf 2s -- ein UI-Setting dafuer wuerde ohne echten Nutzen nur die Konfigflaeche vergroessern. */
const POLL_INTERVAL_MS = 2000;

export async function isVoiceChatEnabled(db: DatabaseService): Promise<boolean> {
  return (await db.getSetting(SETTING_VOICE_CHAT_ENABLED)) === "true";
}

export async function setVoiceChatEnabled(db: DatabaseService, enabled: boolean): Promise<void> {
  await db.setSetting(SETTING_VOICE_CHAT_ENABLED, enabled ? "true" : "false");
}

export class CloudVoiceChatService {
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger,
    private readonly controlDeps: CloudControlDeps
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
    this.logger.info("Cloud-Voice-Chat-Service gestartet", { pollIntervalMs: POLL_INTERVAL_MS });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    // Ueberlappende Ticks vermeiden, falls ein chat.send (LLM-Lauf) laenger dauert als 2s.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const [status, controlEnabled, voiceEnabled] = await Promise.all([
        getConnectionStatus(this.db),
        isCloudControlEnabled(this.db),
        isVoiceChatEnabled(this.db),
      ]);
      // Voice-Chat setzt Cloud Control voraus: dispatchCommand() und die Laravel-Capability-
      // Pruefung sind an dieselbe 'remote_control'-Faehigkeit gebunden.
      if (!status.connected || !controlEnabled || !voiceEnabled) return;

      const pendingCommands = await pollVoiceCommands(this.db);
      for (const command of pendingCommands) {
        this.logger.info("Fuehre Voice-Chat-Befehl aus", { commandId: command.id, type: command.type });
        const outcome = await dispatchCommand(this.controlDeps, command);
        try {
          await reportCommandResult(this.db, command.id, outcome.status, outcome.result);
        } catch (reportError) {
          this.logger.error("Konnte Voice-Chat-Ergebnis nicht melden", {
            commandId: command.id,
            error: reportError instanceof Error ? reportError.message : String(reportError),
          });
        }
      }
    } catch (error) {
      if (error instanceof CloudSyncError) {
        this.logger.debug("Voice-Chat-Poll fehlgeschlagen", { error: error.message });
        return;
      }
      this.logger.error("Voice-Chat-Poll fehlgeschlagen", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.ticking = false;
    }
  }
}
