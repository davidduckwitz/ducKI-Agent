import type { LLMProvider } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import { Executor } from "./executor.js";
import { History } from "./history.js";
export interface AgentOptions {
    name?: string;
    systemPrompt?: string;
    maxIterations?: number;
    timeoutMs?: number;
    enableReflection?: boolean;
    enablePlanning?: boolean;
}
export type AgentStatus = "idle" | "running" | "paused" | "error" | "stopped";
export interface AgentRunResult {
    response: string;
    iterations: number;
    toolsUsed: string[];
    conversationId?: number;
}
export declare class Agent {
    private readonly provider;
    private readonly db;
    readonly name: string;
    private status;
    private systemPrompt;
    private maxIterations;
    private timeoutMs;
    private enableReflection;
    private enablePlanning;
    private conversation;
    private memory;
    private planner;
    readonly executor: Executor;
    private reasoner;
    private reflection;
    private history;
    private logger;
    constructor(provider: LLMProvider, db: DatabaseService, options?: AgentOptions);
    startConversation(options?: {
        name?: string;
        projectId?: number;
    }): Promise<number>;
    loadConversation(id: number): Promise<void>;
    run(userInput: string, options?: {
        stream?: boolean;
        onChunk?: (chunk: string) => void;
    }): Promise<AgentRunResult>;
    private runLoop;
    stop(): void;
    getStatus(): AgentStatus;
    getHistory(): History;
}
//# sourceMappingURL=agent.d.ts.map