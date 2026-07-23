export interface CronJob {
    id: string;
    name: string;
    expression: string;
    task: () => Promise<void>;
    nextRun?: Date;
    lastRun?: Date;
    enabled: boolean;
}
export declare class CronScheduler {
    private jobs;
    private timers;
    private logger;
    constructor();
    schedule(job: Omit<CronJob, "enabled">): CronJob;
    private startJob;
    cancel(id: string): boolean;
    list(): CronJob[];
    stopAll(): void;
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
export declare class TaskQueue<T = unknown> {
    private readonly processor;
    private readonly concurrency;
    private queue;
    private running;
    private logger;
    constructor(processor: (item: QueueItem<T>) => Promise<void>, concurrency?: number);
    enqueue(data: T, options?: {
        priority?: number;
        maxAttempts?: number;
        id?: string;
    }): string;
    private process;
    getStatus(): {
        pending: number;
        running: number;
        completed: number;
    };
}
export { CronScheduler as Scheduler };
//# sourceMappingURL=index.d.ts.map