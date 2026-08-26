/**
 * Message Agent Tool
 *
 * Enables bot-to-bot messaging, similar to hermes-agent's message_agent tool.
 * Bots can send messages to each other with attribution, and the delivery
 * is fire-and-forget with the reply arriving later.
 *
 * This tool is only available in a bot's canonical Bot Chat session, not in
 * regular user chats or group chats.
 */

import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { Logger } from "@ducki/logger";

export interface MessageAgentDeps {
  /** Get a bot by slug */
  getBot: (slug: string) => Promise<{ slug: string; name: string; description: string } | undefined>;
  /** List all bots */
  listBots: () => Promise<Array<{ slug: string; name: string; description: string }>>;
  /** Send a message to a bot's canonical chat */
  sendMessage: (targetSlug: string, message: string) => Promise<{ success: boolean; error?: string }>;
  /** Logger */
  logger: Logger;
}

/**
 * Create the message_agent tool.
 * Only available in a bot's canonical Bot Chat session.
 */
export function createMessageAgentTool(
  deps: MessageAgentDeps,
  currentBotSlug: string
): ToolExecutor {
  return {
    name: "message_agent",
    description: "Send a message to another bot in the fleet",
    definition: {
      name: "message_agent",
      description: "Message another bot. The message will be delivered to the target bot's canonical Bot Chat with attribution.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "The slug of the target bot to message",
          },
          message: {
            type: "string",
            description: "The message to send to the target bot",
          },
        },
        required: ["target", "message"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const target = String(input["target"] ?? "").trim();
      const message = String(input["message"] ?? "").trim();

      if (!target) {
        return {
          success: false,
          data: null,
          error: "message_agent requires a target bot slug",
        };
      }

      if (!message) {
        return {
          success: false,
          data: null,
          error: "message_agent requires a message",
        };
      }

      // Don't message yourself
      if (target === currentBotSlug) {
        return {
          success: false,
          data: null,
          error: "Cannot message yourself",
        };
      }

      // Validate target exists
      const targetBot = await deps.getBot(target);
      if (!targetBot) {
        const available = await deps.listBots();
        const names = available
          .filter((b) => b.slug !== currentBotSlug)
          .map((b) => b.slug)
          .join(", ");
        return {
          success: false,
          data: null,
          error: `Bot '${target}' not found. Available bots: ${names}`,
        };
      }

      // Add attribution prefix
      const attributedMessage = `Message from 🤖 ${currentBotSlug}:\n\n${message}`;

      deps.logger.info("[message_agent] Sending message", {
        from: currentBotSlug,
        to: target,
        messageLength: message.length,
      });

      // Deliver to target's canonical Bot Chat
      const result = await deps.sendMessage(target, attributedMessage);

      if (!result.success) {
        return {
          success: false,
          data: null,
          error: `Failed to deliver message to ${target}: ${result.error ?? "unknown error"}`,
        };
      }

      return {
        success: true,
        data: {
          delivered: true,
          targetBot: target,
          targetName: targetBot.name,
          message: `Message delivered to ${targetBot.name} (@${target}). The reply will arrive in their Bot Chat.`,
        },
      };
    },
  };
}

/**
 * Build the teammate roster for inclusion in a bot's system prompt.
 * This tells the bot who its teammates are and what they do.
 */
export async function buildTeammateRoster(
  deps: MessageAgentDeps,
  currentBotSlug: string
): Promise<string> {
  const bots = await deps.listBots();
  const teammates = bots.filter((b) => b.slug !== currentBotSlug);

  if (teammates.length === 0) {
    return "";
  }

  const roster = teammates
    .map((b) => `- @${b.slug}: ${b.description}`)
    .join("\n");

  return `
## Teammates
You can message other bots using the message_agent tool.
Available teammates:
${roster}

To message a bot: message_agent(target="bot-slug", message="your message")
The bot will receive your message with attribution and reply in their own Bot Chat.`;
}
