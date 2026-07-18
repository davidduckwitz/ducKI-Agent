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
export type AgentRunEventType = "plan" | "iteration" | "tool_call" | "tool_result" | "reasoning" | "decision" | "guardrail";
export interface AgentRunEvent {
    type: AgentRunEventType;
    message: string;
    data?: Record<string, unknown>;
    timestamp: string;
}
export interface AgentRunContextCaps {
    maxSystemPromptChars?: number;
    maxDynamicMemoryChars?: number;
    maxContextMessages?: number;
    maxContextChars?: number;
    maxContextMessageChars?: number;
}
export interface AgentRunOptions {
    stream?: boolean;
    onChunk?: (chunk: string) => void;
    onEvent?: (event: AgentRunEvent) => void;
    contextCaps?: AgentRunContextCaps;
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
    run(userInput: string, options?: AgentRunOptions): Promise<AgentRunResult>;
    private runLoop;
    stop(): void;
    getStatus(): AgentStatus;
    getHistory(): History;
}
//# sourceMappingURL=agent.d.ts.map