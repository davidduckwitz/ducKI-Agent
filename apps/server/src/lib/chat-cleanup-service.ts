import type { DatabaseService, ConversationSelect } from "@ducki/database";
import type { Logger } from "@ducki/logger";

export interface CleanupConfig {
  maxMessagesPerConversation: number;
  archiveAfterDaysInactive: number;
  autoCleanupEnabled: boolean;
}

export class ChatCleanupService {
  private config: CleanupConfig = {
    maxMessagesPerConversation: 50,
    archiveAfterDaysInactive: 30,
    autoCleanupEnabled: true,
  };

  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger
  ) {}

  async loadConfig(): Promise<CleanupConfig> {
    const maxMessages = await this.db.getSetting("chat_max_messages_per_conversation");
    const archiveDays = await this.db.getSetting("chat_archive_after_days");
    const autoCleanup = await this.db.getSetting("chat_auto_cleanup_enabled");

    this.config = {
      maxMessagesPerConversation: maxMessages ? parseInt(maxMessages, 10) : 50,
      archiveAfterDaysInactive: archiveDays ? parseInt(archiveDays, 10) : 30,
      autoCleanupEnabled: autoCleanup ? autoCleanup === "true" : true,
    };

    return this.config;
  }

  async saveConfig(config: Partial<CleanupConfig>): Promise<void> {
    if (config.maxMessagesPerConversation !== undefined) {
      await this.db.setSetting("chat_max_messages_per_conversation", config.maxMessagesPerConversation.toString());
      this.config.maxMessagesPerConversation = config.maxMessagesPerConversation;
    }

    if (config.archiveAfterDaysInactive !== undefined) {
      await this.db.setSetting("chat_archive_after_days", config.archiveAfterDaysInactive.toString());
      this.config.archiveAfterDaysInactive = config.archiveAfterDaysInactive;
    }

    if (config.autoCleanupEnabled !== undefined) {
      await this.db.setSetting("chat_auto_cleanup_enabled", config.autoCleanupEnabled.toString());
      this.config.autoCleanupEnabled = config.autoCleanupEnabled;
    }
  }

  async cleanupConversation(conversationId: number): Promise<{ deleted: number; archived: boolean }> {
    const deleted = await this.db.deleteOldMessages(conversationId, this.config.maxMessagesPerConversation);

    const conversation = await this.db.getConversation(conversationId);
    if (!conversation) {
      return { deleted, archived: false };
    }

    const messageCount = await this.db.getMessageCount(conversationId);
    const isOld = this.isConversationInactive(conversation);

    let archived = false;
    if (isOld && messageCount <= 10) {
      try {
        await this.db.archiveConversation(conversationId, "auto-archived due to inactivity");
        archived = true;
        this.logger.info("Conversation archived", { conversationId, reason: "inactivity" });
      } catch (error) {
        this.logger.warn("Failed to archive conversation", {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { deleted, archived };
  }

  async runGlobalCleanup(): Promise<{
    conversationsProcessed: number;
    messagesDeleted: number;
    conversationsArchived: number;
  }> {
    if (!this.config.autoCleanupEnabled) {
      this.logger.info("Global cleanup skipped (disabled)");
      return { conversationsProcessed: 0, messagesDeleted: 0, conversationsArchived: 0 };
    }

    const conversations = await this.db.listConversations();
    let messagesDeleted = 0;
    let conversationsArchived = 0;

    for (const conversation of conversations) {
      try {
        const result = await this.cleanupConversation(conversation.id);
        messagesDeleted += result.deleted;
        if (result.archived) conversationsArchived++;
      } catch (error) {
        this.logger.error("Cleanup failed for conversation", {
          conversationId: conversation.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.info("Global cleanup completed", {
      conversationsProcessed: conversations.length,
      messagesDeleted,
      conversationsArchived,
    });

    return {
      conversationsProcessed: conversations.length,
      messagesDeleted,
      conversationsArchived,
    };
  }

  private isConversationInactive(conversation: ConversationSelect): boolean {
    const now = new Date();
    const updated = new Date(conversation.updatedAt);
    const daysSinceUpdate = (now.getTime() - updated.getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceUpdate > this.config.archiveAfterDaysInactive;
  }
}
