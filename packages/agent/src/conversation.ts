import type { LLMMessage } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";

export interface ConversationOptions {
  id?: number;
  name?: string;
  projectId?: number;
}

export class ConversationManager {
  private conversationId: number | undefined;
  private messages: LLMMessage[] = [];

  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger
  ) {}

  async start(options: ConversationOptions = {}): Promise<number> {
    const conv = await this.db.createConversation({
      name: options.name ?? `Conversation ${new Date().toLocaleString()}`,
      projectId: options.projectId,
    });

    this.conversationId = conv.id;
    this.messages = [];
    this.logger.info("Conversation started", { id: this.conversationId });
    return this.conversationId;
  }

  async load(conversationId: number): Promise<void> {
    const conv = await this.db.getConversation(conversationId);
    if (!conv) throw new Error(`Conversation ${conversationId} not found`);

    this.conversationId = conversationId;
    const dbMessages = await this.db.getMessages(conversationId);
    const allowedRoles = new Set<LLMMessage["role"]>(["user", "assistant", "system", "tool"]);

    this.messages = dbMessages
      .filter((m) => allowedRoles.has(m.role as LLMMessage["role"]))
      .map((m) => ({
        role: m.role as LLMMessage["role"],
        content: m.content,
        toolCallId: m.toolCallId ?? undefined,
      }));

    this.logger.info("Conversation loaded", { id: conversationId, messages: this.messages.length });
  }

  async addMessage(message: LLMMessage): Promise<void> {
    this.messages.push(message);

    if (this.conversationId !== undefined) {
      const metadata = message.metadata === undefined
        ? undefined
        : typeof message.metadata === "string"
          ? message.metadata
          : JSON.stringify(message.metadata);
      await this.db.addMessage({
        conversationId: this.conversationId,
        role: message.role,
        content: message.content,
        metadata,
        toolCallId: message.toolCallId,
      });
    }
  }

  getMessages(): LLMMessage[] {
    return [...this.messages];
  }

  getLastMessages(count: number): LLMMessage[] {
    return this.messages.slice(-count);
  }

  clearMessages(): void {
    this.messages = [];
  }

  get id(): number | undefined {
    return this.conversationId;
  }
}
