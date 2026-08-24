import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { getRootLogger } from "@ducki/logger";
import { MAIN_BOT_SLUG, type BotService } from "./bot-service.js";

const logger = getRootLogger().child("DelegateToBotTool");

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

/**
 * Lets the main agent delegate a sub-task to a purpose-built bot (custom persona, or the
 * built-in CodingAgent) instead of doing everything itself. Only ever registered on the main
 * agent (see buildAgentFactory in index.ts) - a bot's own Agent instance (BotService.
 * createAgentForBot) never gets this tool, so a bot cannot delegate again and there is no
 * recursion to guard against.
 *
 * Takes a getter (not the service instance) because BotService is constructed after
 * buildAgentFactory - same late-bound-ref pattern as createWikiTool's getWikiService.
 */
export function createDelegateToBotTool(getBotService: () => BotService | undefined): ToolExecutor {
  return {
    name: "delegate_to_bot",
    description:
      "Delegate a sub-task to a specialized bot (a custom persona, or the built-in CodingAgent) instead of handling it yourself. Use action=list first to see which bots exist and what they are for, then action=run with the chosen bot's slug and a clear, self-contained task description (the bot has no memory of this conversation beyond its own chat history).",
    definition: {
      name: "delegate_to_bot",
      description: "List available bots, or run a task on one of them and get its reply back.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "run"], description: "list=see available bots, run=delegate a task" },
          botId: { type: "string", description: "The bot's slug (from action=list). Required for action=run." },
          task: { type: "string", description: "Self-contained task/question for the bot. Required for action=run." },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const botService = getBotService();
      if (!botService) return fail("Bot service is not available");

      const action = String(input["action"] ?? "list").toLowerCase();

      try {
        if (action === "list") {
          const bots = await botService.listBots();
          return ok({
            bots: bots
              // The main agent delegating to itself is not a sub-task, it is a no-op recursion risk.
              .filter((bot) => bot.slug !== MAIN_BOT_SLUG)
              .map((bot) => ({ slug: bot.slug, name: bot.name, description: bot.description ?? undefined })),
          });
        }

        if (action === "run") {
          const botId = String(input["botId"] ?? "").trim();
          const task = String(input["task"] ?? "").trim();
          if (!botId) return fail("delegate_to_bot:run requires field 'botId' (see action=list)");
          if (!task) return fail("delegate_to_bot:run requires field 'task'");
          if (botId === MAIN_BOT_SLUG) return fail("Cannot delegate to the main agent itself - handle this task directly.");

          const bot = await botService.getBot(botId);
          if (!bot) return fail(`No bot with slug '${botId}'. Use action=list to see available bots.`);

          const result = await botService.chat(bot, task);
          return ok({ bot: bot.slug, response: result.response });
        }

        return fail(`Unknown action '${action}'. Use 'list' or 'run'.`);
      } catch (error) {
        logger.error("delegate_to_bot failed", { error: error instanceof Error ? error.message : String(error) });
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
