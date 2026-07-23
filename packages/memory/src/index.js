export class KnowledgeBase {
    db;
    logger;
    constructor(db, logger) {
        this.db = db;
        this.logger = logger;
    }
    store(entry) {
        this.db.addMemory({
            content: entry.content,
            importance: entry.importance,
            type: "semantic",
            conversationId: undefined,
        });
        this.logger.debug("Knowledge stored", { content: entry.content.slice(0, 50) });
    }
    async search(query, limit = 10) {
        const all = await this.db.getMemories(undefined, "semantic");
        const q = query.toLowerCase();
        return all
            .filter((m) => m.content.toLowerCase().includes(q))
            .slice(0, limit)
            .map((m) => ({ id: m.id, content: m.content, importance: m.importance }));
    }
    async getAll() {
        return (await this.db.getMemories(undefined, "semantic")).map((m) => ({
            id: m.id,
            content: m.content,
            importance: m.importance,
        }));
    }
}
export class EmbeddingsManager {
    db;
    provider;
    logger;
    constructor(db, provider, logger) {
        this.db = db;
        this.provider = provider;
        this.logger = logger;
    }
    cosineSimilarity(a, b) {
        if (a.length !== b.length)
            return 0;
        const dot = a.reduce((sum, ai, i) => sum + ai * (b[i] ?? 0), 0);
        const magA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
        const magB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
        return magA && magB ? dot / (magA * magB) : 0;
    }
    async store(content, metadata) {
        // Store without embeddings for now (would need embedding endpoint)
        this.db.addEmbedding({
            content,
            embedding: JSON.stringify([]),
            metadata: metadata ? JSON.stringify(metadata) : undefined,
        });
    }
}
export class Summarizer {
    provider;
    logger;
    constructor(provider, logger) {
        this.provider = provider;
        this.logger = logger;
    }
    async summarize(messages, maxLength = 500) {
        if (messages.length === 0)
            return "";
        const conversation = messages
            .filter((m) => m.role !== "system")
            .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
            .join("\n");
        const response = await this.provider.generate([
            {
                role: "system",
                content: "Summarize the following conversation briefly and accurately.",
            },
            {
                role: "user",
                content: `Summarize in max ${maxLength} chars:\n\n${conversation}`,
            },
        ], { temperature: 0.3, maxTokens: 300 });
        return response.content;
    }
}
export class MemoryManager {
    knowledgeBase;
    embeddings;
    summarizer;
    constructor(db, provider, logger) {
        this.knowledgeBase = new KnowledgeBase(db, logger);
        this.embeddings = new EmbeddingsManager(db, provider, logger);
        this.summarizer = new Summarizer(provider, logger);
    }
}
export { KnowledgeBase as KnowledgeBaseService };
//# sourceMappingURL=index.js.map