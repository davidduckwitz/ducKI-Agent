import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";

export async function setupDefaultCronjobs(db: DatabaseService, logger: Logger): Promise<void> {
  try {
    const existing = await db.listCronJobs();
    const hasCleanupJob = existing.some((job) => job.name === "Auto Chat Cleanup");

    if (!hasCleanupJob) {
      await db.createCronJob({
        name: "Auto Chat Cleanup",
        schedule: "0 2 * * 0", // Sonntag 2 Uhr morgens
        targetType: "cleanup",
        targetRef: "auto",
        enabled: 1,
        payload: JSON.stringify({
          reason: "automatic weekly cleanup",
        }),
      });

      logger.info("Default cleanup cronjob created", {
        schedule: "0 2 * * 0",
        description: "Runs every Sunday at 2 AM",
      });
    }
  } catch (error) {
    logger.warn("Failed to setup default cronjobs", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
