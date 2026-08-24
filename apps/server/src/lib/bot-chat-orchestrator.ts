import type { BotSelect, DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import type { BotService } from "./bot-service.js";
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
 * (a bot that @mentions another has an implied ordering). Speaking order is still rotated each
 * round for fairness. A bot's own @mention of another participant opens a further round, capped
 * by MAX_ROUNDS/MAX_MESSAGES_PER_ROUND so a mention chain cannot run forever; a round where every
 * responder passes ends the whole exchange (mirrors Hermes: "a round where zero members posted a
 * real reply ends the drive"), which falls out naturally here since a pass never contains a
 * mention to seed a next round. A bot can also write "@user" to flag that a message needs the
 * human's decision (surfaced via BotChatTurn.needsUserDecision, stored in messages.metadata for
 * the UI to badge on reload).
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
    // Default-construct a handoff service if none is injected, so every
    // orchestrator always has one. The handoff service only reads/writes
    // tasks — it never makes LLM calls on its own, so a default instance
    // is safe even when the caller didn't wire one in explicitly.
    this.handoffService = handoffService ?? new BotHandoffService(db);
  }

  /** Whether the user message contains cues that the mentioned bots should run
   *  sequentially (e.g. "@a do X, then @b do Y") rather than in parallel. */
  private hasSequentialCues(userMessage: string): boolean {
    return SEQUENTIAL_CUE_RE.test(userMessage);
  }

  /** Splits round responders into batches that can run in parallel. Bots in the same
   *  batch have no dependency on each other and can execute concurrently. Sequential
   *  cues in the user message force single-bot batches (full sequential fallback).
   *  Bot-mention triggers (subsequent rounds) always stay sequential - a bot that
   *  @mentions another has an implied ordering.
   *
   *  Returns an array of batches; each batch is an array of [slug, trigger] pairs.
   *  The caller should run batches sequentially but bots within a batch in parallel. */
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

    // Subsequent rounds (bot mentions) always stay sequential - the mentioning
    // bot's reply was the trigger, so the ordering is implied.
    const hasBotMentions = entries.some(([, trigger]) => trigger.kind === "bot_mention");
    if (hasBotMentions || this.hasSequentialCues(userMessage)) {
      return entries.map((entry) => [entry]);
    }

    // Round 1 with no sequential cues: all independent bots run as one parallel batch.
    return [entries];
  }

  /**
   * Runs the whole multi-round exchange. The caller (routes/bot-chats.ts) does NOT await this on
   * the request path - it persists the user's message itself, responds immediately, and lets this
   * keep running in the background so bot replies land in `messages` (and become visible via
   * polling) as soon as each one finishes, not all at once when the entire exchange is done.
   *
   * Round-1 independent responders run in PARALLEL batches (see buildExecutionBatches).
   * Subsequent rounds (bot @mentions) and rounds with sequential-ordering cues stay sequential.
   *
   * Handoff tracking: the user message and every bot reply are scanned for handoff
   * patterns ("@botB übernimm X") — matching patterns create tracked tasks. Open handoffs
   * from previous turns are injected into each bot's delegated prompt so they see what
   * tasks are assigned to them.
   *
   * `onActiveBotChange` is called with a SET of currently-active slugs (not a single value)
   * since multiple bots can now run concurrently within a parallel batch. Called with
   * `{slug, name}` before each bot starts and with just the slug on completion; when the
   * set becomes empty (all bots in the batch finished), called with null.
   */
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

    // Ensure the shared workspace directory exists for this group chat.
    // Does NOT re-inject the context message into the transcript (that happens
    // once at chat creation via the POST /api/bot-chats route). Creating the
    // directory here is idempotent and cheap (existsSync guard).
    sharedWorkspace.resolveGroupWorkspace(conversationId);

    // Scan the user's own message for handoff patterns ("@botB übernimm X").
    // Fire-and-forget: we don't need the result for the first round's prompts,
    // since the handoff was just created and the bots haven't processed it yet.
    void this.handoffService.processMessageForHandoffs(userMessage, "user", conversationId, participantSlugs);

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
    // Workspace context is static per chat — build it once.
    const workspaceContext = sharedWorkspace.getWorkspaceContext(conversationId);
    // Pre-fetch handoff context once per round (it only changes when a handoff is
    // created, which happens after bot replies complete).
    let handoffContext = await this.handoffService.getHandoffContext(conversationId);
    // Combined header prepended to every bot's delegated prompt.
    const buildContextHeader = () => [workspaceContext, handoffContext].filter(Boolean).join("\n\n");

    while (round <= maxRounds && responders.size > 0) {
      const batches = parallelEnabled
        ? this.buildExecutionBatches(round, responders, userMessage, maxMessagesPerRound)
        : this.buildExecutionBatches(round, responders, userMessage, maxMessagesPerRound).flatMap((b) => b.map((e) => [e]));
      const nextTriggers = new Map<string, Trigger>();

      for (const batch of batches) {
        const capped = batch.slice(0, parallelMaxConcurrent);

        const activeBots = new Set<string>();
        const notifyActive = () => {
          const active = [...activeBots];
          if (active.length === 0) { onActiveBotChange?.(null); return; }
          const first = capped.find(([s]) => activeBots.has(s));
          if (first) {
            const bot = participants.get(first[0]);
            if (bot) onActiveBotChange?.({ slug: bot.slug, name: bot.name });
          }
        };

        const batchResults = await Promise.allSettled(
          capped.map(async ([slug, trigger]) => {
            const bot = participants.get(slug);
            if (!bot) return;

            activeBots.add(slug);
            notifyActive();

            const prompt = this.buildDelegatedPrompt(bot, trigger, buildContextHeader());

            let result: { response: string; messageId?: number; stalled: boolean };
            try {
              result = await this.botService.chat(bot, prompt, { conversationId, tagPromptAsInternal: true });
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
              return { round, botId: slug, botName: bot.name, content: errorMessage.content, messageId: errorMessage.id, needsUserDecision: false, passed: false } satisfies BotChatTurn;
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

            // Scan the bot's reply for handoff patterns.
            if (!passed) {
              void this.handoffService.processMessageForHandoffs(result.response, slug, conversationId, participantSlugs);

              for (const mentioned of extractMentionedSlugs(result.response)) {
                if (mentioned === slug || !participants.has(mentioned)) continue;
                nextTriggers.set(mentioned, { kind: "bot_mention", sourceBotName: bot.name });
              }
            }

            return {
              round, botId: slug, botName: bot.name, content: result.response,
              messageId: result.messageId, needsUserDecision, passed,
            } satisfies BotChatTurn;
          })
        );

        for (const outcome of batchResults) {
          if (outcome.status === "fulfilled" && outcome.value) {
            turns.push(outcome.value);
          }
        }
      }

      responders = nextTriggers;
      round++;
      // Re-fetch handoff context for the next round — new handoffs may have
      // been created by this round's bot replies.
      handoffContext = await this.handoffService.getHandoffContext(conversationId);
    }

    return turns;
  }

  /** Round 1 responder pick: explicit @mentions win; with none, EVERY participant gets a turn -
   *  no relevance heuristic pre-filters who's "allowed" to answer. Matches Hermes "Bot Mode"'s
   *  own rule exactly ("@mentioned bots respond, everyone when nobody is mentioned") and its
   *  explicit design choice of no LLM router: an irrelevant bot is expected to reply "(pass)"
   *  itself (see PASS_RE) rather than being excluded by a keyword-overlap guess beforehand -
   *  the model's own judgment of relevance is more accurate than a Jaccard/keyword score ever
   *  was, and unlike that heuristic it costs nothing extra when everyone would have passed
   *  anyway (a pass is short and never displayed). */
  private pickInitialResponders(userMessage: string, participants: Map<string, BotSelect>): Map<string, Trigger> {
    const mentioned = [...extractMentionedSlugs(userMessage)].filter((slug) => participants.has(slug));
    if (mentioned.length > 0) {
      return new Map(mentioned.map((slug) => [slug, { kind: "user_mention" as const }]));
    }
    return new Map([...participants.keys()].map((slug) => [slug, { kind: "user_broadcast" as const }]));
  }

  /**
   * Tells a bot WHY it's being asked to respond - never HOW (no length/tone/brevity wording
   * here). The real user message is already in the transcript this bot's Agent.run() loads
   * (see handleUserMessage's upfront db.addMessage), so this only needs to point at it.
   *
   * Every variant ends with the same reminders about content-in-message and the (pass)
   * convention. When `handoffContext` is non-empty, it is prepended so the bot sees open
   * tasks assigned to it (or other bots) at the top of the prompt.
   */
  private buildDelegatedPrompt(bot: BotSelect, trigger: Trigger, handoffContext?: string): string {
    const handoffHeader = handoffContext
      ? [`[Offene Aufgaben für diesen Chat:]", ${handoffContext}`, ""].join("\n")
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
