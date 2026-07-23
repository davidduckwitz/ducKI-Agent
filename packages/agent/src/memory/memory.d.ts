import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
import type { LLMMessage } from "@ducki/shared";
export interface MemoryEntry {
    id?: number;
    content: string;
    importance: number;
    type: "short-term" | "long-term" | "episodic" | "semantic";
    conversationId?: number;
}
export interface TaskMemoryDecision {
    shouldRemember: boolean;
    stored: boolean;
    reason: string;
    content?: string;
    importance?: number;
}
export interface ToolMemoryDecision {
    shouldRemember: boolean;
    stored: boolean;
    reason: string;
    content?: string;
    importance?: number;
}
export declare class MemorySystem {
    private readonly db;
    private readonly logger;
    private shortTermBuffer;
    private readonly maxShortTerm;
    constructor(db: DatabaseService, logger: Logger);
    addShortTerm(content: string, importance?: number, conversationId?: number): Promise<void>;
    addLongTerm(content: string, importance?: number, conversationId?: number): Promise<void>;
    addLongTermIfNovel(content: string, importance?: number, conversationId?: number): Promise<boolean>;
    rememberFromSuccessfulTask(taskInput: Record<string, unknown>, taskResultData: unknown, conversationId?: number): Promise<TaskMemoryDecision>;
    rememberFromSuccessfulTool(toolName: string, toolInput: Record<string, unknown>, toolResultData: unknown, conversationId?: number): Promise<ToolMemoryDecision>;
    private consolidate;
    getRelevantContext(query: string, limit?: number): Promise<string[]>;
    buildSystemContext(conversationId?: number): Promise<string>;
    buildDynamicContext(signals: string[], conversationId?: number, limit?: number): Promise<string>;
    summarizeConversation(messages: LLMMessage[]): string;
    private asObject;
    private getKnowledgePool;
    private profileBoost;
    private shouldStoreLearning;
    private normalize;
    private similarity;
}
//# sourceMappingURL=memory.d.ts.map