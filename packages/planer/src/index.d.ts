import type { DatabaseService } from "@ducki/database";
import type { LLMProvider } from "@ducki/providers";
import type { Logger } from "@ducki/logger";
import type { Task, TaskStatus, TaskPriority } from "@ducki/shared";
export interface PlanNode {
    id: string;
    taskId?: number;
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    dependsOn: string[];
    children: PlanNode[];
    result?: string;
}
export declare class TaskGraph {
    private nodes;
    addNode(node: PlanNode): void;
    getNode(id: string): PlanNode | undefined;
    getReadyNodes(): PlanNode[];
    updateStatus(id: string, status: TaskStatus, result?: string): void;
    isComplete(): boolean;
    toArray(): PlanNode[];
}
export declare class TaskPlanner {
    private readonly db;
    private readonly provider;
    private readonly logger;
    constructor(db: DatabaseService, provider: LLMProvider, logger: Logger);
    createTasksFromGoal(goal: string, projectId?: number): Promise<number[]>;
    buildGraph(tasks: Task[]): TaskGraph;
}
export { TaskPlanner as Planner };
//# sourceMappingURL=index.d.ts.map