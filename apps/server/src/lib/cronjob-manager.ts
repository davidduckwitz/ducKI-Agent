import type { Agent } from "@ducki/agent";
import { AVAILABLE_SKILLS, jaccardSimilarity } from "@ducki/agent";
import { computeNextRun, openPluginDb, type CronJobSelect, type DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import { SHARED_WORKSPACE_ROOT } from "@ducki/tools";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgentWithRepairRetry } from "./agent-retry.js";
import { ChatCleanupService } from "./chat-cleanup-service.js";
import { agentRegistry } from "./agent-registry.js";
import { sendPushNotification, CloudSyncError } from "./cloud-sync.js";
import { notifyCodingRunFinished } from "./coding-notify.js";

interface PromptPayload {
  prompt?: string;
  projectId?: number;
  conversationName?: string;
}

interface ToolPayload {
  toolName?: string;
  input?: Record<string, unknown>;
}

interface SkillPayload {
  prompt?: string;
  projectId?: number;
  conversationName?: string;
}

/** Optional dispatchers for target types that run outside the chat agent (workflow, coding). */
export interface CronjobDispatchers {
  /** Run a workflow by id (returns a run summary). */
  runWorkflow?: (workflowId: string) => Promise<unknown>;
  /** Run the coding agent toward a goal (returns its result). */
  runCoding?: (goal: string, options?: { verifyCommand?: string; sandboxRoot?: string }) => Promise<unknown>;
}

export class CronjobManager {
  private timer: NodeJS.Timeout | undefined;
  private readonly running = new Set<number>();
  private readonly intervalMs: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly createAgent: () => Promise<Agent>,
    private readonly logger: Logger,
    private readonly dispatchers: CronjobDispatchers = {}
  ) {
    this.intervalMs = Number.parseInt(process.env["CRONJOB_TICK_MS"] ?? "30000", 10);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    void this.tick();
    this.logger.info("Cronjob manager started", { intervalMs: this.intervalMs });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.logger.info("Cronjob manager stopped");
  }

  async runNow(id: number): Promise<CronJobSelect | undefined> {
    const job = await this.db.getCronJob(id);
    if (!job) return undefined;
    await this.executeJob(job);
    return this.db.getCronJob(id);
  }

  private async tick(): Promise<void> {
    const jobs = await this.db.listCronJobs(true);
    const now = new Date();

    for (const job of jobs) {
      if (this.running.has(job.id)) continue;

      if (!job.nextRunAt) {
        await this.db.updateCronJob(job.id, {
          nextRunAt: computeNextRun(job.schedule, now).toISOString(),
        });
        continue;
      }

      const next = new Date(job.nextRunAt);
      if (next.getTime() <= now.getTime()) {
        await this.executeJob(job);
      }
    }
  }

  private parsePayload<T>(payload: string | null): T {
    if (!payload) return {} as T;
    try {
      return JSON.parse(payload) as T;
    } catch {
      return {} as T;
    }
  }

  private async executeJob(job: CronJobSelect): Promise<void> {
    if (this.running.has(job.id)) return;
    this.running.add(job.id);
    this.notifyJobStarted(job);

    // One-shot jobs (e.g. a calendar appointment trigger) fire exactly once, then disable
    // themselves so a failed run also never repeats.
    const isOneShot = job.runOnce === 1;

    try {
      const result = await this.dispatch(job);
      if (isOneShot) await this.db.updateCronJob(job.id, { enabled: 0 });
      const nextRunAt = !isOneShot && job.enabled ? computeNextRun(job.schedule, new Date()).toISOString() : undefined;
      await this.db.setCronJobRunResult(job.id, {
        status: "success",
        result: result?.slice(0, 4000),
        nextRunAt,
      });
      this.logger.info("Cronjob executed", { id: job.id, name: job.name, targetType: job.targetType });
      if (job.targetType === "coding") {
        notifyCodingRunFinished(this.db, this.logger, job.name, { success: true, summary: result });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isOneShot) await this.db.updateCronJob(job.id, { enabled: 0 });
      await this.db.setCronJobRunResult(job.id, {
        status: "failed",
        error: message,
      });
      this.logger.error("Cronjob execution failed", { id: job.id, name: job.name, error: message });
      if (job.targetType === "coding") {
        notifyCodingRunFinished(this.db, this.logger, job.name, { success: false, summary: message });
      }
    } finally {
      this.running.delete(job.id);
    }
  }

  /** Fire-and-forget "a cronjob started" push - skipped for internal maintenance jobs
   *  (log cleanup, skill curation, the daily calendar reminder scan itself) since the user
   *  never scheduled those themselves and a notification for each would just be noise. The
   *  calendar reminder job sends its own, more useful per-event notifications instead. */
  private notifyJobStarted(job: CronJobSelect): void {
    if (job.targetType === "cleanup" || job.targetType === "skill_curation" || job.targetType === "calendar_reminder") return;
    void sendPushNotification(this.db, `Cronjob gestartet: ${job.name}`, `Typ: ${job.targetType}`, "/cronjobs").catch((error) => {
      if (error instanceof CloudSyncError) return;
      this.logger.warn("Cronjob-start push notification failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  private async dispatch(job: CronJobSelect): Promise<string> {
    if (job.targetType === "tool" && job.targetRef === "logs") {
      return this.runLogsMaintenanceJob(job);
    }

    if (job.targetType === "cleanup") {
      return this.runCleanupJob(job);
    }

    if (job.targetType === "skill_curation") {
      return this.runSkillCuratorJob(job);
    }

    switch (job.targetType) {
      case "task":
        return this.runTaskJob(job);
      case "prompt":
        return this.runPromptJob(job);
      case "tool":
        return this.runToolJob(job);
      case "skill":
        return this.runSkillJob(job);
      case "workflow":
        return this.runWorkflowJob(job);
      case "coding":
        return this.runCodingJob(job);
      case "calendar_reminder":
        return this.runCalendarReminderJob(job);
      default:
        throw new Error(`Unsupported cronjob target type '${job.targetType}'`);
    }
  }

  private async runWorkflowJob(job: CronJobSelect): Promise<string> {
    const workflowId = job.targetRef?.trim();
    if (!workflowId) throw new Error("Workflow cronjob requires targetRef workflow id");
    if (!this.dispatchers.runWorkflow) throw new Error("Workflow dispatcher is not configured");

    const summary = await this.dispatchers.runWorkflow(workflowId);
    return typeof summary === "string" ? summary : JSON.stringify(summary);
  }

  private async runCodingJob(job: CronJobSelect): Promise<string> {
    interface CodingPayload {
      goal?: string;
      verifyCommand?: string;
      sandboxRoot?: string;
    }
    const payload = this.parsePayload<CodingPayload>(job.payload);
    const goal = payload.goal?.trim() || job.targetRef?.trim();
    if (!goal) throw new Error("Coding cronjob requires payload.goal or targetRef");
    if (!this.dispatchers.runCoding) throw new Error("Coding dispatcher is not configured");

    const result = await this.dispatchers.runCoding(goal, {
      verifyCommand: payload.verifyCommand,
      sandboxRoot: payload.sandboxRoot,
    });
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  /** Daily built-in job (see default-cronjobs.ts) - pushes one notification per calendar event
   *  whose `start` falls on today's local date. Reads the calendar plugin's own SQLite storage
   *  directly rather than going through its tool, since there's no chat turn to run a tool call
   *  in here. Matches by date-prefix (not a parsed Date range) because the calendar tool stores
   *  `start` as whatever ISO-ish string the caller gave it (e.g. "2026-08-10T10:00", no explicit
   *  timezone) - a LIKE 'YYYY-MM-DD%' prefix match is the only comparison that doesn't need to
   *  guess a timezone for it. Never calls storage.close() - openPluginDb() hands out one shared,
   *  process-wide client per plugin name, and close() would tear it down for every other caller.
   */
  private async runCalendarReminderJob(_job: CronJobSelect): Promise<string> {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    interface EventRow {
      id: number;
      title: string;
      start: string;
      all_day: number;
      location: string | null;
    }

    let events: EventRow[];
    try {
      const storage = openPluginDb("calendar");
      events = await storage.query<EventRow>(
        "SELECT id, title, start, all_day, location FROM events WHERE start LIKE ? ORDER BY start ASC",
        [`${todayStr}%`]
      );
    } catch (error) {
      // Calendar plugin not installed/enabled, or its table doesn't exist yet - not an error
      // worth failing the cronjob run over.
      return `Calendar lookup skipped: ${error instanceof Error ? error.message : String(error)}`;
    }

    for (const event of events) {
      const timeLabel = event.all_day ? "Ganztägig" : (event.start.split("T")[1]?.slice(0, 5) ?? "");
      const body = [timeLabel, event.location].filter(Boolean).join(" · ") || "Heute";
      void sendPushNotification(this.db, `Termin heute: ${event.title}`, body, "/calendar").catch((error) => {
        if (error instanceof CloudSyncError) return;
        this.logger.warn("Calendar reminder push failed", {
          eventId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return `${events.length} Termin(e) heute`;
  }

  private async runTaskJob(job: CronJobSelect): Promise<string> {
    const taskId = Number.parseInt(job.targetRef ?? "", 10);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      throw new Error("Task cronjob requires numeric targetRef task id");
    }

    const task = await this.db.getTask(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);

    await this.db.updateTask(taskId, { status: "running" });

    const prompt = [
      "Execute this tracked task and return what you did and the concrete result:",
      `Task: ${task.title}`,
      task.description ? `Description: ${task.description}` : "Description: (none)",
      `Priority: ${task.priority}`,
      "Use tools where necessary. Keep the final result concise and actionable.",
    ].join("\n");

    let runId: string | undefined;
    try {
      let conversationId = job.conversationId ?? undefined;

      const run = await runAgentWithRepairRetry(
        this.createAgent,
        prompt,
        (errorMessage) => [
          "The previous cron task run failed with a runtime error.",
          `Error: ${errorMessage}`,
          "Start a fresh attempt from scratch and produce a corrected solution.",
          prompt,
        ].join("\n"),
        async (runAgent) => {
          if (!conversationId) {
            const newConversationId = await runAgent.startConversation({
              name: `Cron Task #${taskId}`,
              projectId: task.projectId || undefined,
            });
            if (newConversationId) {
              conversationId = newConversationId;
              await this.db.updateCronJob(job.id, { conversationId });
            }
          } else {
            await runAgent.loadConversation(conversationId);
          }

          runId = agentRegistry.register({
            source: "task_run",
            taskId,
            conversationId,
            label: `Cron Task #${taskId}`,
          });
        }
      );
      await this.db.updateTask(taskId, { status: "completed", result: run.result.response });
      return run.result.response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.updateTask(taskId, { status: "failed", result: message });
      throw error;
    } finally {
      if (runId) agentRegistry.unregister(runId);
    }
  }

  private async runPromptJob(job: CronJobSelect): Promise<string> {
    const payload = this.parsePayload<PromptPayload>(job.payload);
    const prompt = payload.prompt?.trim() || job.targetRef?.trim();
    if (!prompt) throw new Error("Prompt cronjob requires payload.prompt or targetRef");

    let runId: string | undefined;
    try {
      let conversationId = job.conversationId ?? undefined;

      const run = await runAgentWithRepairRetry(
        this.createAgent,
        prompt,
        (errorMessage) => [
          "The previous cron prompt run failed with a runtime error.",
          `Error: ${errorMessage}`,
          "Try again from a clean start with a new solution path.",
          prompt,
        ].join("\n"),
        async (runAgent) => {
          if (!conversationId) {
            conversationId = await runAgent.startConversation({
              name: payload.conversationName?.trim() || `Cron Prompt #${job.id}`,
              projectId: payload.projectId,
            });
            await this.db.updateCronJob(job.id, { conversationId });
          } else {
            await runAgent.loadConversation(conversationId);
          }

          if (conversationId) {
            runId = agentRegistry.register({
              source: "chat_http",
              conversationId,
              label: `Cron Prompt #${job.id}`,
            });
          }
        }
      );
      return run.result.response;
    } finally {
      if (runId) agentRegistry.unregister(runId);
    }
  }

  private async runToolJob(job: CronJobSelect): Promise<string> {
    const payload = this.parsePayload<ToolPayload>(job.payload);
    const toolName = job.targetRef?.trim() || payload.toolName?.trim();
    if (!toolName) throw new Error("Tool cronjob requires targetRef or payload.toolName");

    const input = payload.input && typeof payload.input === "object" ? payload.input : {};

    const prompt = [
      `Execute the tool '${toolName}' with the following input and return the result:`,
      `Tool: ${toolName}`,
      `Input: ${JSON.stringify(input, null, 2)}`,
      "Return what the tool produced as the result.",
    ].join("\n");

    let runId: string | undefined;
    try {
      let conversationId = job.conversationId ?? undefined;

      const run = await runAgentWithRepairRetry(
        this.createAgent,
        prompt,
        (errorMessage) => [
          "The previous cron tool run failed with a runtime error.",
          `Error: ${errorMessage}`,
          "Try again from a clean start with the same tool and input.",
          prompt,
        ].join("\n"),
        async (runAgent) => {
          if (!conversationId) {
            conversationId = await runAgent.startConversation({
              name: `Cron Tool #${toolName} ${job.id}`,
            });
            await this.db.updateCronJob(job.id, { conversationId });
          } else {
            await runAgent.loadConversation(conversationId);
          }

          if (conversationId) {
            runId = agentRegistry.register({
              source: "chat_http",
              conversationId,
              label: `Cron Tool #${toolName}`,
            });
          }
        }
      );
      return run.result.response;
    } finally {
      if (runId) agentRegistry.unregister(runId);
    }
  }

  private async runSkillJob(job: CronJobSelect): Promise<string> {
    const payload = this.parsePayload<SkillPayload>(job.payload);
    const skillSlug = job.targetRef?.trim();
    if (!skillSlug) throw new Error("Skill cronjob requires targetRef skill slug");

    const prompt = payload.prompt?.trim() || "Execute the scheduled skill run and report the outcome.";
    let runId: string | undefined;
    try {
      let conversationId = job.conversationId ?? undefined;

      const run = await runAgentWithRepairRetry(
        this.createAgent,
        `/${skillSlug} ${prompt}`,
        (errorMessage) => [
          "The previous cron skill run failed with a runtime error.",
          `Error: ${errorMessage}`,
          "Retry from scratch with a new solution path and return the corrected result.",
          `/${skillSlug} ${prompt}`,
        ].join("\n"),
        async (runAgent) => {
          if (!conversationId) {
            conversationId = await runAgent.startConversation({
              name: payload.conversationName?.trim() || `Cron Skill #${job.id}`,
              projectId: payload.projectId,
            });
            await this.db.updateCronJob(job.id, { conversationId });
          } else {
            await runAgent.loadConversation(conversationId);
          }

          if (conversationId) {
            runId = agentRegistry.register({
              source: "chat_http",
              conversationId,
              label: `Cron Skill #${skillSlug}`,
            });
          }
        }
      );
      return run.result.response;
    } finally {
      if (runId) agentRegistry.unregister(runId);
    }
  }

  private async runLogsMaintenanceJob(job: CronJobSelect): Promise<string> {
    interface LogsPayload {
      action?: string;
      maxEntries?: number;
    }

    const payload = this.parsePayload<LogsPayload>(job.payload);
    const action = payload.action?.toLowerCase() || "cleanup";
    const maxEntries = payload.maxEntries ?? 100;

    if (action === "cleanup") {
      const deleted = await this.db.cleanupLogs(maxEntries);
      return `Cleaned up ${deleted} old log entries, keeping last ${maxEntries}`;
    }

    throw new Error(`Unknown logs maintenance action '${action}'`);
  }

  private async runCleanupJob(job: CronJobSelect): Promise<string> {
    const cleanup = new ChatCleanupService(this.db, this.logger);
    const result = await cleanup.runGlobalCleanup();
    return JSON.stringify(result);
  }

  /**
   * LLM-free, periodic skill hygiene pass - a pragmatic stand-in for a full curator: marks
   * skills nobody has used in a while as "stale" (never deletes) and flags description pairs
   * that look like they might overlap, for a human to review. Writes a report next to the
   * other agent-authored reports the user already keeps in shared-workspace/reports/.
   */
  private async runSkillCuratorJob(job: CronJobSelect): Promise<string> {
    interface CuratorPayload {
      staleDays?: number;
      overlapThreshold?: number;
    }
    const payload = this.parsePayload<CuratorPayload>(job.payload);
    const staleDays = payload.staleDays ?? 30;
    const overlapThreshold = payload.overlapThreshold ?? 0.6;

    const usage = await this.db.getSkillUsageAll();
    const staleCutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;

    const staleSlugs: string[] = [];
    for (const row of usage) {
      if (row.status === "stale") continue;
      if (new Date(row.lastUsedAt).getTime() < staleCutoff) {
        await this.db.markSkillStale(row.slug);
        staleSlugs.push(row.slug);
      }
    }

    const overlaps: Array<{ a: string; b: string; score: number }> = [];
    for (let i = 0; i < AVAILABLE_SKILLS.length; i++) {
      for (let j = i + 1; j < AVAILABLE_SKILLS.length; j++) {
        const skillA = AVAILABLE_SKILLS[i]!;
        const skillB = AVAILABLE_SKILLS[j]!;
        const score = jaccardSimilarity(skillA.description ?? "", skillB.description ?? "");
        if (score >= overlapThreshold) {
          overlaps.push({ a: skillA.slug, b: skillB.slug, score });
        }
      }
    }

    const report = [
      "# Skill Curator Report",
      `Generated: ${new Date().toISOString()}`,
      "",
      `## Stale skills (unused for ${staleDays}+ days) - marked, not deleted`,
      staleSlugs.length > 0 ? staleSlugs.map((s) => `- ${s}`).join("\n") : "(none)",
      "",
      `## Possibly overlapping skills (description similarity >= ${overlapThreshold})`,
      overlaps.length > 0
        ? overlaps.map((o) => `- ${o.a} <-> ${o.b} (${o.score.toFixed(2)})`).join("\n")
        : "(none)",
      "",
      `Tracked skills without any usage data yet: ${Math.max(0, AVAILABLE_SKILLS.length - usage.length)}`,
    ].join("\n") + "\n";

    const reportDir = join(SHARED_WORKSPACE_ROOT, "reports");
    if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, "skill-curator-report.md"), report, "utf8");

    return `Marked ${staleSlugs.length} stale skill(s), found ${overlaps.length} possibly-overlapping pair(s). Report: shared-workspace/reports/skill-curator-report.md`;
  }
}
