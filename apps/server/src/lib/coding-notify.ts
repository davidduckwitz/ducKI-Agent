/**
 * Fire-and-forget push notification for a coding run reaching an end state (success or
 * failure). Shared by every call site that runs a CodingAgent to completion for a
 * user-facing "coding project" (the dedicated /api/coding-agent/run route, plan execution
 * from the chat UI, and cronjob-triggered coding jobs) so the notification wording and the
 * "never break the run that triggered it" behavior stay in one place instead of being
 * copy-pasted at each site.
 */
import type { DatabaseService } from "@ducki/database";
import { sendPushNotification, CloudSyncError } from "./cloud-sync.js";

interface CodingRunResultLike {
  success?: boolean;
  summary?: string;
}

interface MinimalLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export function notifyCodingRunFinished(
  db: DatabaseService,
  logger: MinimalLogger,
  label: string,
  result: CodingRunResultLike
): void {
  const title = result.success ? `Coding-Projekt fertig: ${label}` : `Coding-Projekt fehlgeschlagen: ${label}`;
  const body = (result.summary ?? "").trim().slice(0, 180) || (result.success ? "Erfolgreich abgeschlossen." : "Der Lauf ist fehlgeschlagen.");
  void sendPushNotification(db, title, body, "/coding").catch((error) => {
    // Missing cloud key / no push subscription is an expected, silent no-op elsewhere
    // (see push-notification-tool.ts) - here it's not even user-facing, so just log it.
    if (error instanceof CloudSyncError) {
      logger.warn("Coding-run push notification skipped", { reason: error.message });
      return;
    }
    logger.warn("Coding-run push notification failed", { error: error instanceof Error ? error.message : String(error) });
  });
}
