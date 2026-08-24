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

    // CodingAgent is a mutating worker and its CodingAgent.run() wrapper reloads the shared
    // conversation itself. Keep it deterministic and side-effect-safe by splitting the otherwise
    // parallel round around it while still allowing contiguous non-coding peers to run in parallel.
    const batches: Array<Array<[string, Trigger]>> = [];
    let parallelBatch: Array<[string, Trigger]> = [];
    const flushParallel = () => {
      if (parallelBatch.length > 0) {
        batches.push(parallelBatch);
        parallelBatch = [];
      }
    };

    for (const entry of entries) {
      if (entry[0] === CODING_BOT_SLUG) {
        flushParallel();
        batches.push([entry]);
      } else {
        parallelBatch.push(entry);
      }
    }
    flushParallel();

    return batches;
  }

  async handleUserMessage(
    conversationId: number,
    participantSlugs: string[],
    userMessage: string,
    onActiveBotChange?: (bot: { slug: string; name: string } | null) => void
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
          const activeBots = new Set<string>();
          const notifyActive = () => {
            const active = [...activeBots];
            if (active.length === 0) {
              onActiveBotChange?.(null);
              return;
            }
            const first = chunk.find(([s]) => activeBots.has(s));
            if (first) {
              const bot = participants.get(first[0]);
              if (bot) onActiveBotChange?.({ slug: bot.slug, name: bot.name });
            }
          };

          const chunkResults = await Promise.allSettled(
            chunk.map(async ([slug, trigger]): Promise<BatchTurnResult | undefined> => {
              const bot = participants.get(slug);
              if (!bot) return undefined;

              activeBots.add(slug);
              notifyActive();

              const prompt = this.buildDelegatedPrompt(bot, trigger, buildContextHeader());

              let result: { response: string; messageId?: number; stalled: boolean };
              try {
                result = await this.botService.chat(bot, prompt, {
                  conversationId,
                  tagPromptAsInternal: true,
                  ...(preparedAgents.has(slug) ? { preparedAgent: preparedAgents.get(slug)! } : {}),
                });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn("Bot chat turn failed, skipping this bot for this round", { bot: slug, error: message });
                const errorMessage = await this.db.addMessage({
                  conversationId,
                  role: "assistant",
                  content: `⚠️ ${bot.name} konnte nicht antworten (technischer Fehler): ${message}`,
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

  private buildDelegatedPrompt(bot: BotSelect, trigger: Trigger, handoffContext?: string): string {
    const handoffHeader = handoffContext
      ? ["[Offene Aufgaben für diesen Chat:]", handoffContext, ""].join("\n")
      : "";
    const contentReminder =
      "Schreibe das eigentliche Ergebnis (den Text, die Antwort, den Bericht - was auch immer verlangt wurde) direkt in diese Nachricht. Beschreibe nicht nur, dass du etwas erledigt oder \"gesendet\" hast - eine Beschreibung ohne Inhalt ist für die anderen im Chat unsichtbar. Kürze echte, umfangreiche Inhalte nicht künstlich, nur damit die Antwort kompakter wirkt.";
    const passReminder =
      "Wenn du inhaltlich nichts Neues beizutragen hast, antworte NUR mit exakt \"(pass)\" (ohne alles andere). Das ist eine gute, erwünschte Antwort - sie lässt das Gespräch zur Ruhe kommen, statt es mit einer Nachricht zu füllen, die niemandem weiterhilft.";
    const handoffReminder =
      'Wenn du eine Aufgabe an einen anderen Bot übergibst, schreibe "@botname übernimm <aufgabe>" — das erstellt eine nachverfolgbare Aufgabe. Wenn ein anderer Bot dir eine Aufgabe zugewiesen hat und du sie erledigt hast, schreibe "@botname erledigt" oder "@botname done".';

    if (trigger.kind === "user_mention") {
      return [
        `[Gruppen-Chat: Der Nutzer hat dich (@${bot.name}) in seiner letzten Nachricht direkt erwähnt.]`,
        "Antworte darauf, so wie es deiner Rolle entspricht.",
        handoffHeader,
        contentReminder,
        handoffReminder,
        passReminder,
      ].filter(Boolean).join("\n");
    }
    if (trigger.kind === "bot_mention") {
      return [
        `[Gruppen-Chat: ${trigger.sourceBotName} hat dich (@${bot.name}) in diesem Chat erwähnt und um deine Antwort gebeten.]`,
        "Sieh dir den bisherigen Gesprächsverlauf an und antworte darauf, so wie es deiner Rolle entspricht.",
        handoffHeader,
        contentReminder,
        handoffReminder,
        passReminder,
      ].filter(Boolean).join("\n");
    }
    return [
      `[Gruppen-Chat: Die letzte Nachricht im Verlauf richtet sich an die ganze Gruppe (keine gezielte Erwähnung).]`,
      "Wenn du inhaltlich etwas beizutragen hast, antworte so, wie es deiner Rolle entspricht.",
      handoffHeader,
      contentReminder,
      handoffReminder,
      passReminder,
    ].filter(Boolean).join("\n");
  }
}
