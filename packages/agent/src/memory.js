export class MemorySystem {
    db;
    logger;
    shortTermBuffer = [];
    maxShortTerm = 20;
    constructor(db, logger) {
        this.db = db;
        this.logger = logger;
    }
    addShortTerm(content, importance = 1, conversationId) {
        const entry = { content, importance, type: "short-term", conversationId };
        this.shortTermBuffer.push(entry);
        if (this.shortTermBuffer.length > this.maxShortTerm) {
            this.consolidate();
        }
        this.db.addMemory({
            content,
            importance,
            type: "short-term",
            conversationId,
        });
    }
    addLongTerm(content, importance = 5, conversationId) {
        this.db.addMemory({
            content,
            importance,
            type: "long-term",
            conversationId,
        });
        this.logger.debug("Long-term memory added", { content: content.slice(0, 50) });
    }
    consolidate() {
        // Keep the most important entries
        this.shortTermBuffer = this.shortTermBuffer
            .sort((a, b) => b.importance - a.importance)
            .slice(0, Math.floor(this.maxShortTerm / 2));
    }
    getRelevantContext(query, limit = 5) {
        const longTerm = this.db.getMemories(undefined, "long-term");
        const relevant = longTerm
            .filter((m) => m.content.toLowerCase().includes(query.toLowerCase()))
            .slice(0, limit)
            .map((m) => m.content);
        return relevant;
    }
    buildSystemContext(conversationId) {
        const memories = this.db.getMemories(conversationId, "long-term").slice(0, 5);
        if (memories.length === 0)
            return "";
        return `\n\n## Relevant Memory\n${memories.map((m) => `- ${m.content}`).join("\n")}`;
    }
    summarizeConversation(messages) {
        const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content);
        const assistantMessages = messages
            .filter((m) => m.role === "assistant")
            .map((m) => m.content.slice(0, 100));
        return `User discussed: ${userMessages.slice(-3).join("; ")}. Agent responded about: ${assistantMessages.slice(-3).join("; ")}`;
    }
}
//# sourceMappingURL=memory.js.map