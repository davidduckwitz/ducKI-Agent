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
export declare class MemorySystem {
    private readonly db;
    private readonly logger;
    private shortTermBuffer;
    private readonly maxShortTerm;
    constructor(db: DatabaseService, logger: Logger);
    addShortTerm(content: string, importance?: number, conversationId?: number): void;
    addLongTerm(content: string, importance?: number, conversationId?: number): void;
    private consolidate;
    getRelevantContext(query: string, limit?: number): string[];
    buildSystemContext(conversationId?: number): string;
    summarizeConversation(messages: LLMMessage[]): string;
}
//# sourceMappingURL=memory.d.ts.map