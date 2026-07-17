import type { Agent } from "@ducki/agent";
import { computeNextRun, type CronJobSelect, type DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";

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

export class CronjobManager {
  private timer: NodeJS.Timeout | undefined;
  private readonly running = new Set<number>();
  private readonly intervalMs: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly createAgent: () => Agent,
    private readonly logger: Logger
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

    try {
      const result = await this.dispatch(job);
      const nextRunAt = job.enabled ? computeNextRun(job.schedule, new Date()).toISOString() : undefined;
      await this.db.setCronJobRunResult(job.id, {
        status: "success",
        result: result?.slice(0, 4000),
        nextRunAt,
      });
      this.logger.info("Cronjob executed", { id: job.id, name: job.name, targetType: job.targetType });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.setCronJobRunResult(job.id, {
        status: "failed",
        error: message,
      });
      this.logger.error("Cronjob execution failed", { id: job.id, name: job.name, error: message });
    } finally {
      this.running.delete(job.id);
    }
  }

  private async dispatch(job: CronJobSelect): Promise<string> {
    switch (job.targetType) {
      case "task":
        return this.runTaskJob(job);
      case "prompt":
        return this.runPromptJob(job);
      case "tool":
        return this.runToolJob(job);
      case "skill":
        return this.runSkillJob(job);
      default:
        throw new Error(`Unsupported cronjob target type '${job.targetType}'`);
    }
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

    const agent = this.createAgent();
    if (task.projectId) {
      await agent.startConversation({ name: `Cron Task #${taskId}`, projectId: task.projectId });
    } else {
      await agent.startConversation({ name: `Cron Task #${taskId}` });
    }

    try {
      const run = await agent.run(prompt);
      await this.db.updateTask(taskId, { status: "completed", result: run.response });
      return run.response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.updateTask(taskId, { status: "failed", result: message });
      throw error;
    }
  }

  private async runPromptJob(job: CronJobSelect): Promise<string> {
    const payload = this.parsePayload<PromptPayload>(job.payload);
    const prompt = payload.prompt?.trim() || job.targetRef?.trim();
    if (!prompt) throw new Error("Prompt cronjob requires payload.prompt or targetRef");

    const agent = this.createAgent();
    await agent.startConversation({
      name: payload.conversationName?.trim() || `Cron Prompt #${job.id}`,
      projectId: payload.projectId,
    });

    const run = await agent.run(prompt);
    return run.response;
  }

  private async runToolJob(job: CronJobSelect): Promise<string> {
    const payload = this.parsePayload<ToolPayload>(job.payload);
    const toolName = job.targetRef?.trim() || payload.toolName?.trim();
    if (!toolName) throw new Error("Tool cronjob requires targetRef or payload.toolName");

    const input = payload.input && typeof payload.input === "object" ? payload.input : {};
    const agent = this.createAgent();
    const result = await agent.executor.execute(toolName, input);

    if (!result.success) {
      throw new Error(result.error ?? `Tool '${toolName}' failed`);
    }

    return typeof result.data === "string" ? result.data : JSON.stringify(result.data);
  }

  private async runSkillJob(job: CronJobSelect): Promise<string> {
    const payload = this.parsePayload<SkillPayload>(job.payload);
    const skillSlug = job.targetRef?.trim();
    if (!skillSlug) throw new Error("Skill cronjob requires targetRef skill slug");

    const prompt = payload.prompt?.trim() || "Execute the scheduled skill run and report the outcome.";
    const agent = this.createAgent();
    await agent.startConversation({
      name: payload.conversationName?.trim() || `Cron Skill #${job.id}`,
      projectId: payload.projectId,
    });

    const run = await agent.run(`/${skillSlug} ${prompt}`);
    return run.response;
  }
}
