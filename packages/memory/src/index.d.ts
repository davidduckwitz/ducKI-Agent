import type { DatabaseService } from "@ducki/database";
import type { LLMProvider } from "@ducki/providers";
import type { Logger } from "@ducki/logger";
import type { LLMMessage } from "@ducki/shared";
export interface KnowledgeEntry {
    id?: number;
    content: string;
    category?: string;
    importance: number;
    embedding?: number[];
}
export declare class KnowledgeBase {
    private readonly db;
    private readonly logger;
    constructor(db: DatabaseService, logger: Logger);
    store(entry: KnowledgeEntry): void;
    search(query: string, limit?: number): Promise<KnowledgeEntry[]>;
    getAll(): Promise<KnowledgeEntry[]>;
}
export declare class EmbeddingsManager {
    private readonly db;
    private readonly provider;
    private readonly logger;
    constructor(db: DatabaseService, provider: LLMProvider, logger: Logger);
    cosineSimilarity(a: number[], b: number[]): number;
    store(content: string, metadata?: Record<string, unknown>): Promise<void>;
}
export declare class Summarizer {
    private readonly provider;
    private readonly logger;
    constructor(provider: LLMProvider, logger: Logger);
    summarize(messages: LLMMessage[], maxLength?: number): Promise<string>;
}
export declare class MemoryManager {
    readonly knowledgeBase: KnowledgeBase;
    readonly embeddings: EmbeddingsManager;
    readonly summarizer: Summarizer;
    constructor(db: DatabaseService, provider: LLMProvider, logger: Logger);
}
export { KnowledgeBase as KnowledgeBaseService };
//# sourceMappingURL=index.d.ts.map