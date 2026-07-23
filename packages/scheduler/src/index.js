import { getRootLogger } from "@ducki/logger";
function parseCronExpression(expression) {
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
    jobs = new Map();
    timers = new Map();
    logger;
    constructor() {
        this.logger = getRootLogger().child("CronScheduler");
    }
    schedule(job) {
        const cronJob = { ...job, enabled: true };
        this.jobs.set(job.id, cronJob);
        this.startJob(cronJob);
        this.logger.info("Cron job scheduled", { id: job.id, expression: job.expression });
        return cronJob;
    }
    startJob(job) {
        const intervalMs = parseCronExpression(job.expression);
        const timer = setInterval(async () => {
            if (!job.enabled)
                return;
            job.lastRun = new Date();
            job.nextRun = new Date(Date.now() + intervalMs);
            this.logger.info("Running cron job", { id: job.id });
            try {
                await job.task();
            }
            catch (error) {
                this.logger.error("Cron job failed", {
                    id: job.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }, intervalMs);
        this.timers.set(job.id, timer);
        job.nextRun = new Date(Date.now() + intervalMs);
    }
    cancel(id) {
        const timer = this.timers.get(id);
        if (timer) {
            clearInterval(timer);
            this.timers.delete(id);
            const job = this.jobs.get(id);
            if (job)
                job.enabled = false;
            this.logger.info("Cron job cancelled", { id });
            return true;
        }
        return false;
    }
    list() {
        return Array.from(this.jobs.values());
    }
    stopAll() {
        for (const id of this.timers.keys()) {
            this.cancel(id);
        }
    }
}
export class TaskQueue {
    processor;
    concurrency;
    queue = [];
    running = false;
    logger;
    constructor(processor, concurrency = 1) {
        this.processor = processor;
        this.concurrency = concurrency;
        this.logger = getRootLogger().child("TaskQueue");
    }
    enqueue(data, options = {}) {
        const id = options.id ?? `task_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const item = {
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
        }
        else {
            this.queue.splice(insertIdx, 0, item);
        }
        this.process().catch((e) => this.logger.error("Queue process error", { error: String(e) }));
        return id;
    }
    async process() {
        if (this.running)
            return;
        this.running = true;
        while (this.queue.length > 0) {
            const item = this.queue.find((q) => q.status === "pending");
            if (!item)
                break;
            item.status = "running";
            item.attempts++;
            try {
                await this.processor(item);
                item.status = "completed";
                this.logger.debug("Task completed", { id: item.id });
            }
            catch (error) {
                this.logger.warn("Task failed", {
                    id: item.id,
                    attempt: item.attempts,
                    maxAttempts: item.maxAttempts,
                });
                if (item.attempts < item.maxAttempts) {
                    item.status = "pending";
                    // Exponential backoff
                    await new Promise((r) => setTimeout(r, Math.pow(2, item.attempts) * 1000));
                }
                else {
                    item.status = "failed";
                }
            }
            // Remove completed/failed items
            this.queue = this.queue.filter((q) => q.status !== "completed" && q.status !== "failed");
        }
        this.running = false;
    }
    getStatus() {
        return {
            pending: this.queue.filter((q) => q.status === "pending").length,
            running: this.queue.filter((q) => q.status === "running").length,
            completed: 0, // Completed items are removed from queue
        };
    }
}
export { CronScheduler as Scheduler };
//# sourceMappingURL=index.js.map