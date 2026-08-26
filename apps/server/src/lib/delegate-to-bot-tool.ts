import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { getRootLogger } from "@ducki/logger";
import {
  CODING_BOT_SLUG,
  CODING_SPECIALIST_BOT_SLUGS,
  MAIN_BOT_SLUG,
  type BotService,
} from "./bot-service.js";

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
export interface DelegateToBotToolOptions {
  mode?: "main" | "coding";
  sandboxRoot?: string;
  isEnabled?: () => Promise<boolean>;
  maxDelegations?: number;
}

export function createDelegateToBotTool(
  getBotService: () => BotService | undefined,
  options: DelegateToBotToolOptions = {}
): ToolExecutor {
  const codingMode = options.mode === "coding";
  let delegationCount = 0;
  return {
    name: "delegate_to_bot",
    description:
      codingMode
        ? "Delegate a substantial, clearly bounded frontend or backend work package to a coding specialist and wait for completion. Use only when delegation saves significant context or adds specialist value; handle small/local edits yourself. After return, inspect and verify the specialist's changes before marking the plan step complete."
        : "Delegate a sub-task to a specialized bot (a custom persona, or the built-in CodingAgent) instead of handling it yourself. Use action=list first to see which bots exist and what they are for, then action=run with the chosen bot's slug and a clear, self-contained task description (the bot has no memory of this conversation beyond its own chat history).",
    definition: {
      name: "delegate_to_bot",
      description: "List available bots, or run a task on one of them and get its reply back.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "run"], description: "list=see available bots, run=delegate a task" },
          botId: { type: "string", description: "The bot's slug (from action=list). Required for action=run." },
          task: { type: "string", description: "Self-contained task/question for the bot. Required for action=run." },
          files: { type: "array", items: { type: "string" }, description: "Relevant project-relative files for a coding delegation." },
          acceptanceCriteria: { type: "array", items: { type: "string" }, description: "Concrete conditions the delegated change must satisfy." },
          verifyCommand: { type: "string", description: "Optional verification command the specialist should run." },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const botService = getBotService();
      if (!botService) return fail("Bot service is not available");

      const action = String(input["action"] ?? "list").toLowerCase();

      try {
        if (codingMode && options.isEnabled && !(await options.isEnabled())) {
          return fail("Coding multi-bot delegation is disabled by CODING_MULTI_BOT_ENABLED");
        }
        if (action === "list") {
          const bots = await botService.listBots();
          return ok({
            bots: bots
              // The main agent delegating to itself is not a sub-task, it is a no-op recursion risk.
              .filter((bot) =>
                codingMode ? CODING_SPECIALIST_BOT_SLUGS.has(bot.slug) : bot.slug !== MAIN_BOT_SLUG
              )
              .map((bot) => ({ slug: bot.slug, name: bot.name, description: bot.description ?? undefined })),
          });
        }

        if (action === "run") {
          if (codingMode && delegationCount >= (options.maxDelegations ?? 6)) {
            return fail(`Coding delegation limit (${options.maxDelegations ?? 6}) reached; finish the task directly.`);
          }
          const botId = String(input["botId"] ?? "").trim();
          const task = String(input["task"] ?? "").trim();
          if (!botId) return fail("delegate_to_bot:run requires field 'botId' (see action=list)");
          if (!task) return fail("delegate_to_bot:run requires field 'task'");
          if (botId === MAIN_BOT_SLUG) return fail("Cannot delegate to the main agent itself - handle this task directly.");
          if (codingMode && (botId === CODING_BOT_SLUG || !CODING_SPECIALIST_BOT_SLUGS.has(botId))) {
            return fail("CodingAgent may delegate only to frontend-developer or backend-infrastructure.");
          }

          const bot = await botService.getBot(botId);
          if (!bot) return fail(`No bot with slug '${botId}'. Use action=list to see available bots.`);
          if (codingMode) delegationCount++;

          const files = Array.isArray(input["files"])
            ? input["files"].filter((value): value is string => typeof value === "string")
            : [];
          const acceptanceCriteria = Array.isArray(input["acceptanceCriteria"])
            ? input["acceptanceCriteria"].filter((value): value is string => typeof value === "string")
            : [];
          const verifyCommand = String(input["verifyCommand"] ?? "").trim();
          const delegatedTask = codingMode
            ? [
                "You are working as a specialist for a parent CodingAgent. Implement the work now; do not only describe it.",
                `Task: ${task}`,
                files.length ? `Relevant project-relative files:\n- ${files.join("\n- ")}` : "",
                acceptanceCriteria.length ? `Acceptance criteria:\n- ${acceptanceCriteria.join("\n- ")}` : "",
                verifyCommand ? `Verification command: ${verifyCommand}` : "",
                "Return a concise summary with changed files, checks run, and any remaining warnings. The parent CodingAgent will independently verify the result.",
              ].filter(Boolean).join("\n\n")
            : task;

          // Coding specialists run in a disposable conversation. Reusing their persistent bot
          // chat would import unrelated history into this tool result and can poison the parent
          // CodingAgent's Decision/Verifier/Reflection context.
          const result = codingMode
            ? await botService.chatIsolated(
                bot,
                delegatedTask,
                options.sandboxRoot ? { sandboxRoot: options.sandboxRoot } : undefined
              )
            : await botService.chat(bot, delegatedTask);
          return ok({ status: "completed", bot: bot.slug, response: result.response });
        }

        return fail(`Unknown action '${action}'. Use 'list' or 'run'.`);
      } catch (error) {
        logger.error("delegate_to_bot failed", { error: error instanceof Error ? error.message : String(error) });
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
