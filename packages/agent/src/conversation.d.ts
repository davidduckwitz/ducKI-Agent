import type { LLMMessage } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";
export interface ConversationOptions {
    id?: number;
    name?: string;
    projectId?: number;
}
export declare class ConversationManager {
    private readonly db;
    private readonly logger;
    private conversationId;
    private messages;
    constructor(db: DatabaseService, logger: Logger);
    start(options?: ConversationOptions): Promise<number>;
    load(conversationId: number): Promise<void>;
    addMessage(message: LLMMessage): void;
    getMessages(): LLMMessage[];
    getLastMessages(count: number): LLMMessage[];
    clearMessages(): void;
    get id(): number | undefined;
}
//# sourceMappingURL=conversation.d.ts.map