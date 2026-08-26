import type { Agent } from "@ducki/agent";
import type { BotSelect, DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import { CODING_BOT_SLUG, type BotService } from "./bot-service.js";
import { BotHandoffService } from "./bot-handoff-service.js";
import { sharedWorkspace } from "./shared-workspace-service.js";

const logger = getRootLogger().child("BotChatOrchestrator");

/** Settings-page keys (Settings > Bots) that control these caps - see BotsSettings.tsx for the
 *  matching frontend fields and their own copies of these same defaults. */
export const BOT_CHAT_MAX_ROUNDS_SETTING = "BOT_CHAT_MAX_ROUNDS";
export const BOT_CHAT_MAX_MESSAGES_PER_ROUND_SETTING = "BOT_CHAT_MAX_MESSAGES_PER_ROUND";
export const BOT_CHAT_PARALLEL_ENABLED_SETTING = "BOT_CHAT_PARALLEL_ENABLED";
export const BOT_CHAT_PARALLEL_MAX_CONCURRENT_SETTING = "BOT_CHAT_PARALLEL_MAX_CONCURRENT";

/**
 * Defaults raised from the original 3/10: those were tuned for a short back-and-forth and cut
 * off legitimately multi-step exchanges early (e.g. "@eddy research X, then write a report,
 * @main then search the web for more" easily needs 4+ rounds: research -> report -> mention ->
 * supplement -> maybe one more clarifying round). Close to Hermes "Bot Mode"'s own hardcoded
 * GROUP_CHAT_MAX_ROUNDS=3 / GROUP_CHAT_MAX_MESSAGES=10 (apps/desktop/src/plugins/hermes-bots/
 * plugin.js), just with more headroom - and unlike Hermes, both stay configurable here via
 * Settings > Bots so a slower local model / cheaper API budget can dial back down.
 */
const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_MAX_MESSAGES_PER_ROUND = 20;
const DEFAULT_PARALLEL_ENABLED = true;
const DEFAULT_PARALLEL_MAX_CONCURRENT = 4;

/** Sequential-ordering cue words that the user's message may contain to signal that
 *  @mentioned bots should run in order, not in parallel. When the user writes
 *  "@eddy research X, @main once that's done search the web for more", the phrase
 *  "once that's done" (or any of these cues) signals that @main must wait for @eddy.
 *  Without any such cue, independent @mentions run in parallel for speed. */
const SEQUENTIAL_CUE_RE = /\b(danach|anschließend|dann|sobald.*fertig|wenn.*erledigt|nachdem|daraufhin|im anschluss|once.*done|after.*that|then|next|afterwards|subsequently|when.*finished|when.*complete)\b/i;

const MENTION_RE = /@([a-z0-9][a-z0-9-]*)/gi;

/**
 * A bot that has nothing to add replies with exactly this token instead of padding out a reply.
 * Ported directly from Hermes "Bot Mode"'s own convention (`isGroupPassText`,
 * `apps/desktop/src/plugins/hermes-bots/plugin.js`: the model is instructed to reply exactly
 * "(pass)", matched case-insensitively with optional parens/trailing period). A pass never
 * displays in the chat (see BotChatOrchestrator.handleUserMessage's metadata tagging and the
 * frontend's authorBotId+!pass filter) and never opens a further round - it is the mechanism
 * that lets an irrelevant bot silently opt out instead of every triggered bot always producing
 * visible filler ("Ich habe nichts hinzuzufügen, aber...").
 */
const PASS_RE = /^\(?\s*pass\s*\)?\.?$/i;

function isPassResponse(text: string): boolean {
  return PASS_RE.test(text.trim());
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface BotChatTurn {
  round: number;
  botId: string;
  botName: string;
  content: string;
  messageId?: number;
  needsUserDecision: boolean;
  passed: boolean;
}

/** Why a bot is being asked to respond this round - purely for prompt wording, never a length or
 *  tone instruction. A bot's own persona (systemPrompt) decides how it answers; see
 *  BotService.createAgentForBot's respectPersonaLength:true, which stops the core agent's default
 *  "keep it short" post-tool-call nudge from overriding that persona. */
type Trigger = { kind: "user_mention" } | { kind: "user_broadcast" } | { kind: "bot_mention"; sourceBotName: string };

type BatchTurnResult = {
  turn: BotChatTurn;
  mentions: Array<{ slug: string; trigger: Trigger }>;
};

function extractMentionedSlugs(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    found.add(match[1]!.toLowerCase());
  }
  return found;
}

function mentionsUser(text: string): boolean {
  return /@user\b/i.test(text);
}

/**
 * Drives a "bot_chat" group conversation - shape ported from Hermes "Bot Mode"'s group chat
 * orchestrator (`apps/desktop/src/plugins/hermes-bots/plugin.js`), which is deliberately a thin,
 * deterministic layer with NO LLM router: on a new user message (already persisted by the caller
 * - see handleUserMessage's doc comment), explicit @mentions decide who responds; with none,
 * EVERY participant gets a turn (no relevance heuristic gatekeeping who's "allowed" to answer -
 * an irrelevant bot is expected to reply "(pass)" instead, not be silently excluded beforehand).
 *
 * Round-1 independent responders run in PARALLEL for speed (3-4x faster on a broadcast or
 * non-sequential multi-mention); sequential-ordering cue words in the user message ("dann",
 * "danach", "once that's done", etc.) force single-bot batches for back-compat with
 * ordered-mention prompts. Subsequent rounds triggered by bot @mentions always stay sequential
 * (a bot that @mentions another has an implied ordering). The CodingAgent is also always isolated
 * into a single-bot batch because it is a mutating worker whose macro run() reloads the shared
 * conversation internally; running it concurrently with other speakers would make both context
 * and filesystem side effects order-dependent.
 *
 * Before any multi-bot batch begins, every non-coding Agent is constructed and loads the shared
 * conversation. The orchestrator awaits ALL of those loads before the first generation starts.
 * This is the immutable round-snapshot barrier: peers in one parallel batch cannot see messages
 * another peer happened to persist milliseconds earlier. A batch larger than maxConcurrent is
 * still fully prepared up front, then executed in bounded chunks, so chunk 2 does not accidentally
 * see chunk 1 even though both belong to the same logical round.
 *
 * Speaking order is still rotated each round for fairness. A bot's own @mention of another
 * participant opens a further round, capped by MAX_ROUNDS/MAX_MESSAGES_PER_ROUND so a mention
 * chain cannot run forever; a round where every responder passes ends the whole exchange
 * (mirrors Hermes: "a round where zero members posted a real reply ends the drive"), which falls
 * out naturally here since a pass never contains a mention to seed a next round. A bot can also
 * write "@user" to flag that a message needs the human's decision (surfaced via
 * BotChatTurn.needsUserDecision, stored in messages.metadata for the UI to badge on reload).
 *
 * Parallel execution is controlled by the BOT_CHAT_PARALLEL_ENABLED and
 * BOT_CHAT_PARALLEL_MAX_CONCURRENT settings (defaults: on, max 4 concurrent).
 */
export class BotChatOrchestrator {
  private readonly handoffService: BotHandoffService;

  constructor(
    private readonly db: DatabaseService,
    private readonly botService: BotService,
    handoffService?: BotHandoffService
  ) {
    this.handoffService = handoffService ?? new BotHandoffService(db);
  }

  private hasSequentialCues(userMessage: string): boolean {
    return SEQUENTIAL_CUE_RE.test(userMessage);
  }

  private buildExecutionBatches(
    round: number,
    responders: Map<string, Trigger>,
    userMessage: string,
    maxMessagesPerRound: number
  ): Array<Array<[string, Trigger]>> {
    const roundSlugs = [...responders.keys()];
    const rotation = roundSlugs.length > 0 ? (round - 1) % roundSlugs.length : 0;
    const rotated = [...roundSlugs.slice(rotation), ...roundSlugs.slice(0, rotation)];
    const entries: Array<[string, Trigger]> = rotated
      .slice(0, maxMessagesPerRound)
      .map((slug) => [slug, responders.get(slug)!]);

    const hasBotMentions = entries.some(([, trigger]) => trigger.kind === "bot_mention");
    if (hasBotMentions || this.hasSequentialCues(userMessage)) {
      return entries.map((entry) => [entry]);
    }

    // BROADCAST: all participants respond. Use SERIAL execution (one bot at a time) so each bot
    // can see the previous bot's response before deciding whether to speak or pass. This mirrors
    // Hermes "Bot Mode"'s serial-round design where bots deliberate in order — a bot that sees
    // another bot already covered the topic passes instead of repeating. Parallel broadcast caused
    // every bot to respond blind, leading to redundant answers.
    return entries.map((entry) => [entry]);
  }

  async handleUserMessage(
    conversationId: number,
    participantSlugs: string[],
    userMessage: string,
    onActiveBotChange?: (bots: Array<{ slug: string; name: string; activity: string }>) => void
  ): Promise<BotChatTurn[]> {
    const participants = new Map<string, BotSelect>();
    for (const slug of participantSlugs) {
      const bot = await this.botService.getBot(slug);
      if (bot) participants.set(slug, bot);
    }

    sharedWorkspace.resolveGroupWorkspace(conversationId);

    // A handoff created directly by the user must be visible to round 1. Await it before
    // fetching the round context so the first delegated prompt cannot race the DB write.
    await this.handoffService.processMessageForHandoffs(userMessage, "user", conversationId, participantSlugs);

    const [maxRoundsSetting, maxMessagesPerRoundSetting, parallelEnabledSetting, parallelMaxConcurrentSetting] = await Promise.all([
      this.db.getSetting(BOT_CHAT_MAX_ROUNDS_SETTING),
      this.db.getSetting(BOT_CHAT_MAX_MESSAGES_PER_ROUND_SETTING),
      this.db.getSetting(BOT_CHAT_PARALLEL_ENABLED_SETTING),
      this.db.getSetting(BOT_CHAT_PARALLEL_MAX_CONCURRENT_SETTING),
    ]);
    const maxRounds = parsePositiveInt(maxRoundsSetting, DEFAULT_MAX_ROUNDS);
    const maxMessagesPerRound = parsePositiveInt(maxMessagesPerRoundSetting, DEFAULT_MAX_MESSAGES_PER_ROUND);
    const parallelEnabled = parallelEnabledSetting === undefined ? DEFAULT_PARALLEL_ENABLED : parallelEnabledSetting.toLowerCase() !== "false";
    const parallelMaxConcurrent = parsePositiveInt(parallelMaxConcurrentSetting, DEFAULT_PARALLEL_MAX_CONCURRENT);

    const turns: BotChatTurn[] = [];
    let round = 1;
    let responders = this.pickInitialResponders(userMessage, participants);
    const workspaceContext = sharedWorkspace.getWorkspaceContext(conversationId);
    let handoffContext = await this.handoffService.getHandoffContext(conversationId);
    const buildContextHeader = () => [workspaceContext, handoffContext].filter(Boolean).join("\n\n");

    while (round <= maxRounds && responders.size > 0) {
      const batches = parallelEnabled
        ? this.buildExecutionBatches(round, responders, userMessage, maxMessagesPerRound)
        : this.buildExecutionBatches(round, responders, userMessage, maxMessagesPerRound).flatMap((b) => b.map((e) => [e]));
      const nextTriggers = new Map<string, Trigger>();

      for (const batch of batches) {
        // A previous sequential batch may have created/closed a handoff. Refresh before building
        // this batch's prompts; for a parallel batch the value then remains fixed until every peer
        // in that batch has completed, matching the conversation snapshot semantics below.
        handoffContext = await this.handoffService.getHandoffContext(conversationId);

        // Immutable parallel-round barrier. The concrete BotService has this method; the runtime
        // feature check keeps lightweight test doubles/back-compat mocks working. Prepare the
        // ENTIRE batch before chunking so maxConcurrent is only a scheduler limit, never a context
        // boundary. If preparation throws, no bot in this batch has started generating yet.
        const preparedAgents = new Map<string, Agent>();
        const prepareFn = (this.botService as unknown as {
          prepareAgentForGroupTurn?: (bot: BotSelect, conversationId: number) => Promise<Agent | undefined>;
        }).prepareAgentForGroupTurn;
        if (batch.length > 1 && typeof prepareFn === "function") {
          const prepared = await Promise.all(
            batch.map(async ([slug]) => {
              const bot = participants.get(slug);
              if (!bot) return undefined;
              const agent = await prepareFn.call(this.botService, bot, conversationId);
              return agent ? ([slug, agent] as const) : undefined;
            })
          );
          for (const item of prepared) {
            if (item) preparedAgents.set(item[0], item[1]);
          }
        }

        // A large parallel batch is processed in bounded chunks instead of being
        // truncated. The previous slice(0, maxConcurrent) silently dropped every
        // responder after the first chunk. All chunks use Agents prepared above, so later chunks
        // still see the same immutable pre-batch history as the first chunk.
        for (let offset = 0; offset < batch.length; offset += parallelMaxConcurrent) {
          const chunk = batch.slice(offset, offset + parallelMaxConcurrent);
          const activeBots = new Map<string, string>(); // slug -> current activity description
          const notifyActive = () => {
            const activeEntries = chunk
              .filter(([s]) => activeBots.has(s))
              .map(([s]) => {
                const bot = participants.get(s);
                return bot ? { slug: bot.slug, name: bot.name, activity: activeBots.get(s) ?? "thinking…" } : undefined;
              })
              .filter((b): b is { slug: string; name: string; activity: string } => Boolean(b));
            onActiveBotChange?.(activeEntries);
          };

          const chunkResults = await Promise.allSettled(
            chunk.map(async ([slug, trigger]): Promise<BatchTurnResult | undefined> => {
              const bot = participants.get(slug);
              if (!bot) return undefined;

              activeBots.set(slug, "thinking…");
              notifyActive();

              const prompt = this.buildDelegatedPrompt(bot, trigger, participants, buildContextHeader(), userMessage);

              let result: { response: string; messageId?: number; stalled: boolean };
              try {
                result = await this.botService.chat(bot, prompt, {
                  conversationId,
                  tagPromptAsInternal: true,
                  ...(preparedAgents.has(slug) ? { preparedAgent: preparedAgents.get(slug)! } : {}),
                  onEvent: (event) => {
                    if (event.type === "tool_call") {
                      const toolName = (event.data?.toolName as string) ?? (event.message?.split?.(" ")?.[0] as string) ?? "working";
                      activeBots.set(slug, toolName);
                      notifyActive();
                    } else if (event.type === "tool_result") {
                      activeBots.set(slug, "analyzing…");
                      notifyActive();
                    }
                  },
                });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn("Bot chat turn failed, skipping this bot for this round", { bot: slug, error: message });
                const errorMessage = await this.db.addMessage({
                  conversationId,
                  role: "assistant",
                  content: `⚠️ ${bot.name} could not respond (technical error): ${message}`,
                  authorBotId: slug,
                });
              activeBots.delete(slug);
              notifyActive();
              return {
                  turn: {
                    round,
                    botId: slug,
                    botName: bot.name,
                    content: errorMessage.content,
                    messageId: errorMessage.id,
                    needsUserDecision: false,
                    passed: false,
                  },
                  mentions: [],
                };
              }

              const passed = isPassResponse(result.response) || result.stalled;
              if (result.stalled) {
                logger.warn("Bot never followed through on its announced action after recovery attempts - hiding as a pass", {
                  bot: slug,
                  announced: result.response,
                });
              }
              const needsUserDecision = !passed && mentionsUser(result.response);
              if (result.messageId !== undefined && (passed || needsUserDecision)) {
                await this.db.tagMessage(result.messageId, {
                  metadata: JSON.stringify({ ...(passed ? { pass: true } : {}), ...(needsUserDecision ? { needsUserDecision: true } : {}) }),
                });
              }

              activeBots.delete(slug);
              notifyActive();

              const mentions: BatchTurnResult["mentions"] = [];
              if (!passed) {
                // Handoffs generated by this response must be committed before any later batch/
                // round reads its handoff context. Awaiting here removes a timing race.
                await this.handoffService.processMessageForHandoffs(result.response, slug, conversationId, participantSlugs);

                for (const mentioned of extractMentionedSlugs(result.response)) {
                  if (mentioned === slug || !participants.has(mentioned)) continue;
                  mentions.push({
                    slug: mentioned,
                    trigger: { kind: "bot_mention", sourceBotName: bot.name },
                  });
                }
              }

              return {
                turn: {
                  round,
                  botId: slug,
                  botName: bot.name,
                  content: result.response,
                  messageId: result.messageId,
                  needsUserDecision,
                  passed,
                },
                mentions,
              };
            })
          );

          // Promise completion order is nondeterministic; Promise.allSettled RESULTS are in INPUT
          // order. Build nextTriggers only here so two parallel bots mentioning the same target
          // cannot race a shared Map.set(). The first speaker in deterministic rotated order wins
          // the sourceBotName used for the next delegated prompt.
          for (const outcome of chunkResults) {
            if (outcome.status !== "fulfilled" || !outcome.value) continue;
            turns.push(outcome.value.turn);
            for (const mention of outcome.value.mentions) {
              if (!nextTriggers.has(mention.slug)) {
                nextTriggers.set(mention.slug, mention.trigger);
              }
            }
          }
        }
      }

      responders = nextTriggers;
      round++;
      handoffContext = await this.handoffService.getHandoffContext(conversationId);
    }

    return turns;
  }

  private pickInitialResponders(userMessage: string, participants: Map<string, BotSelect>): Map<string, Trigger> {
    const mentioned = [...extractMentionedSlugs(userMessage)].filter((slug) => participants.has(slug));
    if (mentioned.length > 0) {
      return new Map(mentioned.map((slug) => [slug, { kind: "user_mention" as const }]));
    }
    return new Map([...participants.keys()].map((slug) => [slug, { kind: "user_broadcast" as const }]));
  }

  /** Detect if the user's message is asking for planning/discussion rather than execution. */
  private isPlanningIntent(userMessage: string): boolean {
    const lower = userMessage.toLowerCase();
    return /\b(plan|discuss|brainstorm|think|approach|how would|what do you think|strategy|outline|architecture|design|before we start|first step|roadmap|how can we|suggest|recommend|what's the best way|what are the options)\b/i.test(lower);
  }

  /** Build a roster of all participants so each bot knows who its teammates are. */
  private buildTeammateRoster(bot: BotSelect, participants: Map<string, BotSelect>): string {
    const lines = ["Teammates in this group chat:"];
    for (const [slug, member] of participants) {
      if (slug === bot.slug) continue; // skip self
      const desc = member.description ? ` — ${member.description}` : "";
      lines.push(`- ${member.name} (@${slug})${desc}`);
    }
    return lines.join("\n");
  }

  /** Build the bot-to-bot messaging protocol instructions. */
  private buildBotModeProtocol(bot: BotSelect, participants: Map<string, BotSelect>): string {
    const roster = this.buildTeammateRoster(bot, participants);
    return [
      "## How to communicate with teammates",
      roster,
      "",
      "To message a teammate directly (they will receive it in their own chat):",
      '  Use @botname in your message, e.g. "@eddy please review this code" — the message will be delivered to that bot.',
      "",
      "To delegate work to a specific teammate:",
      '  Write "@botname take over <task description>" — this creates a trackable handoff.',
      "",
      "To escalate a decision to the user:",
      '  Write "@user" in your message — the user will be notified that their input is needed.',
      "",
      "To pass (you have nothing to add):",
      '  Reply with exactly "(pass)" — this is silent and expected. It lets others speak without noise.',
    ].join("\n");
  }

  private buildDelegatedPrompt(
    bot: BotSelect,
    trigger: Trigger,
    participants: Map<string, BotSelect>,
    handoffContext?: string,
    userMessage?: string,
  ): string {
    const handoffHeader = handoffContext
      ? ["[Open tasks for this chat:]", handoffContext, ""].join("\n")
      : "";

    const isPlanning = userMessage ? this.isPlanningIntent(userMessage) : false;
    const protocol = this.buildBotModeProtocol(bot, participants);

    const groupChatGuidelines = isPlanning
      ? [
          "This is a GROUP CHAT with multiple bots. You are having a CONVERSATION, not working alone.",
          "CRITICAL: Do NOT use any tools (filesystem, shell, browser, HTTP, etc.) in this chat.",
          "Do NOT write code, create files, or execute any actions. Instead, share your perspective, suggest an approach, or discuss how you would tackle this.",
          "Other bots will also share their thoughts. The user wants a discussion first, then delegation to the right bot later.",
          "Read the conversation history before responding — do not repeat what other bots already said.",
        ].join(" ")
      : [
          "This is a GROUP CHAT with multiple bots. You are having a CONVERSATION, not working alone.",
          "CRITICAL: Do NOT use any tools (filesystem, shell, browser, HTTP, etc.) in this chat unless you are explicitly given a handoff task.",
          "Your job RIGHT NOW is to: (1) evaluate if this task is in your area of expertise, (2) claim it or pass, (3) briefly describe HOW you would approach it — but do NOT actually execute it yet.",
          "Only the bot that receives a formal handoff task should execute. All others discuss and coordinate.",
          "If another bot already claimed the task or gave a good answer, reply (pass).",
        ].join(" ");

    const contentReminder =
      "Write your actual result (text, answer, report - whatever was requested) directly in this message. Do NOT just describe that you did something - a description without content is invisible to others in the chat. Do not artificially shorten real, extensive content.";
    const passReminder =
      'If you have nothing new to contribute, reply ONLY with exactly "(pass)" (nothing else). This is a good, expected response - it lets the conversation settle instead of filling it with a message that helps no one.';

    if (trigger.kind === "user_mention") {
      return [
        `[Group Chat: The user directly mentioned you (@${bot.name}) in their last message.]`,
        groupChatGuidelines,
        protocol,
        handoffHeader,
        contentReminder,
        passReminder,
      ].filter(Boolean).join("\n");
    }
    if (trigger.kind === "bot_mention") {
      return [
        `[Group Chat: ${trigger.sourceBotName} mentioned you (@${bot.name}) and requested your response.]`,
        "Review the conversation history. The other bot has asked for your input.",
        groupChatGuidelines,
        protocol,
        handoffHeader,
        contentReminder,
        passReminder,
      ].filter(Boolean).join("\n");
    }
    return [
      `[Group Chat: The last message in the conversation targets the entire group (no specific mention).]`,
      "This is NOT directed at you specifically. Only respond if the task directly matches your expertise AND no other bot has already claimed it. Otherwise reply (pass).",
      "CRITICAL: Do NOT use any tools or write code in this response. This is a discussion turn, not an execution turn.",
      groupChatGuidelines,
      protocol,
      handoffHeader,
      contentReminder,
      passReminder,
    ].filter(Boolean).join("\n");
  }
}
