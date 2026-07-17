export class ConversationManager {
    db;
    logger;
    conversationId;
    messages = [];
    constructor(db, logger) {
        this.db = db;
        this.logger = logger;
    }
    async start(options = {}) {
        const conv = this.db.createConversation({
            name: options.name ?? `Conversation ${new Date().toLocaleString()}`,
            projectId: options.projectId,
        });
        this.conversationId = conv.id;
        this.messages = [];
        this.logger.info("Conversation started", { id: this.conversationId });
        return this.conversationId;
    }
    async load(conversationId) {
        const conv = this.db.getConversation(conversationId);
        if (!conv)
            throw new Error(`Conversation ${conversationId} not found`);
        this.conversationId = conversationId;
        const dbMessages = this.db.getMessages(conversationId);
        this.messages = dbMessages.map((m) => ({
            role: m.role,
            content: m.content,
            toolCallId: m.toolCallId ?? undefined,
        }));
        this.logger.info("Conversation loaded", { id: conversationId, messages: this.messages.length });
    }
    addMessage(message) {
        this.messages.push(message);
        if (this.conversationId !== undefined) {
            this.db.addMessage({
                conversationId: this.conversationId,
                role: message.role,
                content: message.content,
                toolCallId: message.toolCallId,
            });
        }
    }
    getMessages() {
        return [...this.messages];
    }
    getLastMessages(count) {
        return this.messages.slice(-count);
    }
    clearMessages() {
        this.messages = [];
    }
    get id() {
        return this.conversationId;
    }
}
//# sourceMappingURL=conversation.js.map