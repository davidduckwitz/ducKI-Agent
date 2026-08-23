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

    const hasSkillCuratorJob = existing.some((job) => job.name === "Skill Curator");
    if (!hasSkillCuratorJob) {
      await db.createCronJob({
        name: "Skill Curator",
        schedule: "0 3 * * 0", // Sonntag 3 Uhr morgens
        targetType: "skill_curation",
        targetRef: "auto",
        enabled: 1,
        payload: JSON.stringify({
          staleDays: 30,
          overlapThreshold: 0.6,
        }),
      });

      logger.info("Default skill curator cronjob created", {
        schedule: "0 3 * * 0",
        description: "Runs every Sunday at 3 AM",
      });
    }

    const hasCalendarReminderJob = existing.some((job) => job.name === "Calendar Reminder");
    if (!hasCalendarReminderJob) {
      await db.createCronJob({
        name: "Calendar Reminder",
        schedule: "0 7 * * *", // Täglich 7 Uhr morgens
        targetType: "calendar_reminder",
        targetRef: "auto",
        enabled: 1,
        payload: null,
      });

      logger.info("Default calendar reminder cronjob created", {
        schedule: "0 7 * * *",
        description: "Runs daily at 7 AM, pushes a notification for each event scheduled today",
      });
    }
  } catch (error) {
    logger.warn("Failed to setup default cronjobs", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
