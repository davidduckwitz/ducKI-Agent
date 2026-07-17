import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";

export interface CronJob {
  id: string;
  name: string;
  expression: string;
  task: () => Promise<void>;
  nextRun?: Date;
  lastRun?: Date;
  enabled: boolean;
}

function parseCronExpression(expression: string): number {
  // Simplified: only support "*/N" for interval-based cron
  const parts = expression.split(" ");
  const minutePart = parts[0];
  if (minutePart?.startsWith("*/")) {
    const interval = parseInt(minutePart.slice(2));
    return interval * 60 * 1000;
  }
  // Default: 1 hour
  return 60 * 60 * 1000;
}

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, NodeJS.Timeout>();
  private logger: Logger;

  constructor() {
    this.logger = getRootLogger().child("CronScheduler");
  }

  schedule(job: Omit<CronJob, "enabled">): CronJob {
    const cronJob: CronJob = { ...job, enabled: true };
    this.jobs.set(job.id, cronJob);
    this.startJob(cronJob);
    this.logger.info("Cron job scheduled", { id: job.id, expression: job.expression });
    return cronJob;
  }

  private startJob(job: CronJob): void {
    const intervalMs = parseCronExpression(job.expression);

    const timer = setInterval(async () => {
      if (!job.enabled) return;
      job.lastRun = new Date();
      job.nextRun = new Date(Date.now() + intervalMs);
      this.logger.info("Running cron job", { id: job.id });
      try {
        await job.task();
      } catch (error) {
        this.logger.error("Cron job failed", {
          id: job.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, intervalMs);

    this.timers.set(job.id, timer);
    job.nextRun = new Date(Date.now() + intervalMs);
  }

  cancel(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
      const job = this.jobs.get(id);
      if (job) job.enabled = false;
      this.logger.info("Cron job cancelled", { id });
      return true;
    }
    return false;
  }

  list(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  stopAll(): void {
    for (const id of this.timers.keys()) {
      this.cancel(id);
    }
  }
}

export interface QueueItem<T = unknown> {
  id: string;
  data: T;
  priority: number;
  attempts: number;
  maxAttempts: number;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: Date;
}

export class TaskQueue<T = unknown> {
  private queue: QueueItem<T>[] = [];
  private running = false;
  private logger: Logger;

  constructor(
    private readonly processor: (item: QueueItem<T>) => Promise<void>,
    private readonly concurrency = 1
  ) {
    this.logger = getRootLogger().child("TaskQueue");
  }

  enqueue(data: T, options: { priority?: number; maxAttempts?: number; id?: string } = {}): string {
    const id = options.id ?? `task_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const item: QueueItem<T> = {
      id,
      data,
      priority: options.priority ?? 5,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
      status: "pending",
      createdAt: new Date(),
    };

    // Insert by priority (higher = first)
    const insertIdx = this.queue.findIndex((q) => q.priority < item.priority);
    if (insertIdx === -1) {
      this.queue.push(item);
    } else {
      this.queue.splice(insertIdx, 0, item);
    }

    this.process().catch((e) => this.logger.error("Queue process error", { error: String(e) }));
    return id;
  }

  private async process(): Promise<void> {
    if (this.running) return;
    this.running = true;

    while (this.queue.length > 0) {
      const item = this.queue.find((q) => q.status === "pending");
      if (!item) break;

      item.status = "running";
      item.attempts++;

      try {
        await this.processor(item);
        item.status = "completed";
        this.logger.debug("Task completed", { id: item.id });
      } catch (error) {
        this.logger.warn("Task failed", {
          id: item.id,
          attempt: item.attempts,
          maxAttempts: item.maxAttempts,
        });

        if (item.attempts < item.maxAttempts) {
          item.status = "pending";
          // Exponential backoff
          await new Promise((r) => setTimeout(r, Math.pow(2, item.attempts) * 1000));
        } else {
          item.status = "failed";
        }
      }

      // Remove completed/failed items
      this.queue = this.queue.filter(
        (q) => q.status !== "completed" && q.status !== "failed"
      );
    }

    this.running = false;
  }

  getStatus(): { pending: number; running: number; completed: number } {
    return {
      pending: this.queue.filter((q) => q.status === "pending").length,
      running: this.queue.filter((q) => q.status === "running").length,
      completed: 0, // Completed items are removed from queue
    };
  }
}

export { CronScheduler as Scheduler };
