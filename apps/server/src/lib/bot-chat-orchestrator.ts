import type { BotSelect, DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";
import type { BotService } from "./bot-service.js";

const logger = getRootLogger().child("BotChatOrchestrator");

/** Settings-page keys (Settings > Bots) that control these caps - see BotsSettings.tsx for the
 *  matching frontend fields and their own copies of these same defaults. */
export const BOT_CHAT_MAX_ROUNDS_SETTING = "BOT_CHAT_MAX_ROUNDS";
export const BOT_CHAT_MAX_MESSAGES_PER_ROUND_SETTING = "BOT_CHAT_MAX_MESSAGES_PER_ROUND";

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
 * Same-round responders run sequentially (see the loop's own comment for why, unlike Hermes which
 * is single-process and never parallel by construction), with the speaking order rotated each
 * round for fairness. A bot's own @mention of another participant opens a further round, capped
 * by MAX_ROUNDS/MAX_MESSAGES_PER_ROUND so a mention chain cannot run forever; a round where every
 * responder passes ends the whole exchange (mirrors Hermes: "a round where zero members posted a
 * real reply ends the drive"), which falls out naturally here since a pass never contains a
 * mention to seed a next round. A bot can also write "@user" to flag that a message needs the
 * human's decision (surfaced via BotChatTurn.needsUserDecision, stored in messages.metadata for
 * the UI to badge on reload).
 */
export class BotChatOrchestrator {
  constructor(
    private readonly db: DatabaseService,
    private readonly botService: BotService
  ) {}

  /**
   * Runs the whole multi-round exchange. The caller (routes/bot-chats.ts) does NOT await this on
   * the request path - it persists the user's message itself, responds immediately, and lets this
   * keep running in the background so bot replies land in `messages` (and become visible via
   * polling) as soon as each one finishes, not all at once when the entire exchange is done.
   *
   * `onActiveBotChange`, when given, is called with `{slug, name}` right before a bot's turn
   * starts and `null` right after it ends (success, pass, or failure alike) - the route uses this
   * to answer GET /:id/status with which bot is CURRENTLY working, so the UI can show a live
   * "Eddy schreibt..." indicator instead of a generic "someone is thinking" spinner. Since
   * same-round turns run sequentially (see the loop below), at most one bot is ever active for a
   * given conversation at a time - this is a single current value, not a set.
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

    const [maxRoundsSetting, maxMessagesPerRoundSetting] = await Promise.all([
      this.db.getSetting(BOT_CHAT_MAX_ROUNDS_SETTING),
      this.db.getSetting(BOT_CHAT_MAX_MESSAGES_PER_ROUND_SETTING),
    ]);
    const maxRounds = parsePositiveInt(maxRoundsSetting, DEFAULT_MAX_ROUNDS);
    const maxMessagesPerRound = parsePositiveInt(maxMessagesPerRoundSetting, DEFAULT_MAX_MESSAGES_PER_ROUND);

    const turns: BotChatTurn[] = [];
    let round = 1;
    // round 1's responders: explicit mentions in the user's message, or (with none) everyone.
    let responders = this.pickInitialResponders(userMessage, participants);

    while (round <= maxRounds && responders.size > 0) {
      // Rotate who leads this round (Hermes's rotateGroupSpeakers): with several simultaneous
      // responders (typically the no-mention "everyone" case), always asking the same bot first
      // gives it first-mover advantage on every exchange - the human sees its take before anyone
      // else's, round after round. Rotating by round number spreads that around.
      const roundSlugs = [...responders.keys()];
      const rotation = roundSlugs.length > 0 ? (round - 1) % roundSlugs.length : 0;
      const rotated = [...roundSlugs.slice(rotation), ...roundSlugs.slice(0, rotation)];
      const roundEntries: Array<[string, Trigger]> = rotated.slice(0, maxMessagesPerRound).map((slug) => [slug, responders.get(slug)!]);
      const nextTriggers = new Map<string, Trigger>();

      // Deliberately sequential, not parallel: when a user message @mentions several bots with
      // an implied order ("@eddy research X, @main once that's done search the web for more"),
      // running them concurrently means main starts before Eddy has written anything - main sees
      // no report yet, so its "keep going" instinct is to redo Eddy's whole task from scratch
      // instead of the follow-up it was actually asked for. Running in order means every bot's
      // Agent.run() (via loadConversation) sees every earlier bot's reply THIS round already in
      // the transcript, which is what makes "wait for X, then do Y" prompts work at all. It also
      // doesn't cost live-ness: each reply is still persisted (and visible via polling) the
      // moment that bot finishes, one at a time - which is what actually makes them appear to
      // stream in, rather than requiring true parallel execution.
      for (const [slug, trigger] of roundEntries) {
        const bot = participants.get(slug);
        if (!bot) continue;

        const prompt = this.buildDelegatedPrompt(bot, trigger);

        let result: { response: string; messageId?: number; stalled: boolean };
        onActiveBotChange?.({ slug, name: bot.name });
        try {
          // tagPromptAsInternal: `prompt` is our own synthetic directive, never the human's words
          // - BotService.chat tags the row it lands in `metadata.internal` so the chat UI hides
          // it. It also always tags the resolved reply with authorBotId itself now.
          result = await this.botService.chat(bot, prompt, { conversationId, tagPromptAsInternal: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("Bot chat turn failed, skipping this bot for this round", { bot: slug, error: message });
          // A failed turn used to just vanish - no reply, no error, nothing in the transcript to
          // explain why the exchange stalled. Write a visible, clearly-marked failure message
          // instead, tagged the same way a real reply would be, so it survives the chat UI's
          // authorBotId-based filter and the user sees exactly what happened.
          const errorMessage = await this.db.addMessage({
            conversationId,
            role: "assistant",
            content: `⚠️ ${bot.name} konnte nicht antworten (technischer Fehler): ${message}`,
            authorBotId: slug,
          });
          turns.push({ round, botId: slug, botName: bot.name, content: errorMessage.content, messageId: errorMessage.id, needsUserDecision: false, passed: false });
          onActiveBotChange?.(null);
          continue;
        }

        // A persistent stall (bot only ever announces an action across every recovery attempt -
        // see BotService.chat's STALL_RECOVERY_* constants) is treated exactly like a literal
        // "(pass)": per Hermes "Bot Mode"'s own principle, "a failed turn is a pass, never a room
        // error" - showing the false "I will now..." claim as if it were the real answer would be
        // worse than showing nothing, which is exactly what the visible ⚠️ error above is for
        // genuine exceptions but NOT for this (the run didn't throw, it just never delivered).
        const passed = isPassResponse(result.response) || result.stalled;
        if (result.stalled) {
          logger.warn("Bot never followed through on its announced action after recovery attempts - hiding as a pass", {
            bot: slug,
            announced: result.response,
          });
        }
        const needsUserDecision = !passed && mentionsUser(result.response);
        if (result.messageId !== undefined && (passed || needsUserDecision)) {
          // One combined tag call - metadata is a single JSON column, a second call would
          // overwrite rather than merge.
          await this.db.tagMessage(result.messageId, {
            metadata: JSON.stringify({ ...(passed ? { pass: true } : {}), ...(needsUserDecision ? { needsUserDecision: true } : {}) }),
          });
        }

        turns.push({
          round,
          botId: slug,
          botName: bot.name,
          content: result.response,
          messageId: result.messageId,
          needsUserDecision,
          passed,
        });

        onActiveBotChange?.(null);

        // A pass never seeds a next round (it has nothing to mention by construction) and never
        // needs the flood-guard below re-checked - skip straight to the next responder.
        if (passed) continue;

        // A bot mentioning another participant opens the next round for that bot. Self-mentions
        // and mentions of bots not in this chat are ignored.
        for (const mentioned of extractMentionedSlugs(result.response)) {
          if (mentioned === slug) continue;
          if (!participants.has(mentioned)) continue;
          nextTriggers.set(mentioned, { kind: "bot_mention", sourceBotName: bot.name });
        }
      }

      responders = nextTriggers;
      round++;
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
   * Tells a bot WHY it's being asked to respond - never HOW (no length/tone/brevity wording here).
   * The real user message is already in the transcript this bot's Agent.run() loads (see
   * handleUserMessage's upfront db.addMessage), so this only needs to point at it, not restate it.
   *
   * Every variant ends with the same two reminders. First: put the actual content in THIS
   * message, and never thin out real content to make it more compact (ported from Hermes's own
   * prompt instruction, plugin.js line ~6265) - without it a bot asked for e.g. a report tends to
   * answer "I've finished the report and sent it to @main" (a status update instead of the
   * report, since there is no side channel to send it through - the chat message IS the only
   * delivery mechanism), or truncates a genuinely long answer to "sound" appropriately brief for
   * a chat. Second: the (pass) convention, so a bot with nothing to add says so cheaply instead
   * of padding out a reply just to have said something.
   */
  private buildDelegatedPrompt(bot: BotSelect, trigger: Trigger): string {
    const contentReminder =
      "Schreibe das eigentliche Ergebnis (den Text, die Antwort, den Bericht - was auch immer verlangt wurde) direkt in diese Nachricht. Beschreibe nicht nur, dass du etwas erledigt oder \"gesendet\" hast - eine Beschreibung ohne Inhalt ist für die anderen im Chat unsichtbar. Kürze echte, umfangreiche Inhalte nicht künstlich, nur damit die Antwort kompakter wirkt.";
    const passReminder =
      "Wenn du inhaltlich nichts Neues beizutragen hast, antworte NUR mit exakt \"(pass)\" (ohne alles andere). Das ist eine gute, erwünschte Antwort - sie lässt das Gespräch zur Ruhe kommen, statt es mit einer Nachricht zu füllen, die niemandem weiterhilft.";

    if (trigger.kind === "user_mention") {
      return [
        `[Gruppen-Chat: Der Nutzer hat dich (@${bot.name}) in seiner letzten Nachricht direkt erwähnt.]`,
        "Antworte darauf, so wie es deiner Rolle entspricht.",
        contentReminder,
        passReminder,
      ].join("\n");
    }
    if (trigger.kind === "bot_mention") {
      return [
        `[Gruppen-Chat: ${trigger.sourceBotName} hat dich (@${bot.name}) in diesem Chat erwähnt und um deine Antwort gebeten.]`,
        "Sieh dir den bisherigen Gesprächsverlauf an und antworte darauf, so wie es deiner Rolle entspricht.",
        contentReminder,
        passReminder,
      ].join("\n");
    }
    return [
      `[Gruppen-Chat: Die letzte Nachricht im Verlauf richtet sich an die ganze Gruppe (keine gezielte Erwähnung).]`,
      "Wenn du inhaltlich etwas beizutragen hast, antworte so, wie es deiner Rolle entspricht.",
      contentReminder,
      passReminder,
    ].join("\n");
  }
}
