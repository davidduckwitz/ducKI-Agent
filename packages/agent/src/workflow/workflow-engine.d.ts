import type { LLMProvider } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import type { Executor } from "../executor/executor.js";
export type MultiAgentRole = "manager" | "research" | "coding" | "review" | "browser";
export type WorkflowNodeStatus = "pending" | "running" | "completed" | "failed";
export type WorkflowStatus = "draft" | "running" | "completed" | "failed";
export interface WorkflowNode {
    id: string;
    title: string;
    role: MultiAgentRole;
    prompt: string;
    dependsOn?: string[];
    status: WorkflowNodeStatus;
    result?: string;
    taskId?: number;
    position?: {
        x: number;
        y: number;
    };
}
export interface WorkflowEdge {
    id: string;
    source: string;
    target: string;
}
export interface WorkflowGraph {
    id: string;
    name: string;
    goal: string;
    status: WorkflowStatus;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    createdAt: string;
    updatedAt: string;
    lastRunAt?: string;
}
export interface WorkflowRunSummary {
    workflowId: string;
    status: WorkflowStatus;
    completedNodes: number;
    failedNodes: number;
    updatedAt: string;
}
export declare class WorkflowEngine {
    private readonly provider;
    private readonly db;
    private readonly executor?;
    private logger;
    constructor(provider: LLMProvider, db: DatabaseService, executor?: Executor | undefined, logger?: Logger);
    private settingKey;
    listWorkflows(): Promise<WorkflowGraph[]>;
    getWorkflow(id: string): Promise<WorkflowGraph | undefined>;
    saveWorkflow(input: Partial<WorkflowGraph> & Pick<WorkflowGraph, "id" | "name">): Promise<WorkflowGraph>;
    deleteWorkflow(id: string): Promise<void>;
    private pickNextNode;
    private buildRoleSystemPrompt;
    private executeNode;
    private runInternal;
    runWorkflow(id: string): Promise<WorkflowRunSummary>;
    resumeWorkflow(id: string): Promise<WorkflowRunSummary>;
}
//# sourceMappingURL=workflow-engine.d.ts.map