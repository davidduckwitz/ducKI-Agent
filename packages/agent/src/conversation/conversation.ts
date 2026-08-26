import type { LLMMessage, LLMContent } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import type { Logger } from "@ducki/logger";

export interface ConversationOptions {
  id?: number;
  name?: string;
  projectId?: number;
  /** Tags who opened this conversation - see the `conversations.origin` schema comment
   *  (packages/database/src/schema.ts). Undefined/omitted means a normal chat conversation. */
  origin?: string;
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
      origin: options.origin,
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
      .map((m) => {
        let content: string | LLMContent[] = m.content;
        // Parse JSON arrays that were stringified when stored
        if (m.content.startsWith('[')) {
          try {
            const parsed = JSON.parse(m.content);
            if (Array.isArray(parsed)) {
              content = parsed;
            }
          } catch {
            // Keep as string if parsing fails
          }
        }
        let metadata: string | Record<string, unknown> | undefined;
        let toolCalls: LLMMessage["toolCalls"];
        if (m.metadata) {
          try {
            const parsed = JSON.parse(m.metadata);
            metadata = parsed;
            if (Array.isArray(parsed?.nativeToolCalls)) toolCalls = parsed.nativeToolCalls;
          } catch {
            metadata = m.metadata;
          }
        }
        return {
          role: m.role as LLMMessage["role"],
          content,
          toolCallId: m.toolCallId ?? undefined,
          ...(metadata !== undefined ? { metadata } : {}),
          ...(toolCalls ? { toolCalls } : {}),
        };
      });

    this.logger.info("Conversation loaded", { id: conversationId, messages: this.messages.length });
  }

  /**
   * @param displayContent Overrides what gets PERSISTED for this message, without affecting
   *   the in-memory copy used to build this run's actual LLM context (`this.messages`, still
   *   `message` as given). CodingAgent wraps a short goal in a large machine-facing prompt
   *   before calling Agent.run() - without this, the whole scaffold would be written to the
   *   conversation transcript and later shown as if the user had typed it. Safe to lose on
   *   reload: each new attempt/run rebuilds its own full instruction prompt from scratch, it
   *   never depends on a past turn's exact scaffolding text still being in history.
   */
  async addMessage(message: LLMMessage, displayContent?: string): Promise<void> {
    this.messages.push(message);

    if (this.conversationId !== undefined) {
      let metadataRecord: Record<string, unknown> | undefined;
      if (typeof message.metadata === "object" && message.metadata !== null) {
        metadataRecord = { ...message.metadata };
      } else if (typeof message.metadata === "string") {
        try {
          const parsed = JSON.parse(message.metadata);
          metadataRecord = typeof parsed === "object" && parsed !== null ? parsed : { value: parsed };
        } catch {
          metadataRecord = { value: message.metadata };
        }
      }
      if (message.toolCalls?.length) {
        metadataRecord = { ...(metadataRecord ?? {}), nativeToolCalls: message.toolCalls };
      }
      const metadata = metadataRecord === undefined ? undefined : JSON.stringify(metadataRecord);
      const content = displayContent ?? (typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content));
      await this.db.addMessage({
        conversationId: this.conversationId,
        role: message.role,
        content,
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

  /** Replace all in-memory messages (used by tiered compression). */
  setMessages(messages: LLMMessage[]): void {
    this.messages = [...messages];
  }

  get id(): number | undefined {
    return this.conversationId;
  }
}
