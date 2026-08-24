import { Agent, type CodingAgent } from "@ducki/agent";
import type { BotInsert, BotSelect, DatabaseService } from "@ducki/database";
import { createProvider, type LLMProvider, type ProviderName } from "@ducki/providers";
import type { ToolExecutor } from "@ducki/shared";
import { getRootLogger } from "@ducki/logger";
import { randomUUID } from "node:crypto";
import { wrapTools } from "./tool-wrapper.js";
import { runAgentWithRepairRetry, shouldRetryAgentRun } from "./agent-retry.js";
import { deriveConversationTitle } from "./conversation-title.js";

/** Fixed slugs for the two agents that already exist in this app - seeded once so they show up
 *  as ordinary rows in the bots list/UI alongside user-created bots. */
export const MAIN_BOT_SLUG = "main";
export const CODING_BOT_SLUG = "coding";

/** Settings-page keys (Settings > Bots) controlling a single custom bot's own Agent.run() budget
 *  - see BotsSettings.tsx for the matching frontend fields. Falls back to the same defaults the
 *  core Agent class itself uses (AGENT_MAX_ITERATIONS=50, AGENT_TIMEOUT_MS=600000) when unset, so
 *  a bot behaves like the default agent until someone deliberately widens or narrows its budget. */
export const BOT_AGENT_MAX_ITERATIONS_SETTING = "BOT_AGENT_MAX_ITERATIONS";
export const BOT_AGENT_TIMEOUT_MS_SETTING = "BOT_AGENT_TIMEOUT_MS";

const UNRESTRICTED_ACCESS = "*";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseAccessList(raw: string | null): string[] | undefined {
  // Legacy rows used NULL to mean unrestricted. Keep that meaning for backward compatibility,
  // but new/updated custom bots now store an explicit JSON array so [] can safely mean no access.
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const values = parsed.filter((value): value is string => typeof value === "string");
    return values.includes(UNRESTRICTED_ACCESS) ? undefined : values;
  } catch {
    // Malformed access policy must fail closed rather than silently grant every capability.
    return [];
  }
}

function parseMessageMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function metadataHasLocalMessageId(raw: string | null | undefined, localMessageId: string): boolean {
  return parseMessageMetadata(raw)["localMessageId"] === localMessageId;
}

function markMetadataInternal(raw: string | null | undefined): string {
  return JSON.stringify({ ...parseMessageMetadata(raw), internal: true });
}

/**
 * Matches a response that only ANNOUNCES an action ("Ich werde die Recherche durchführen.") with
 * no tool call and no actual content - a known failure mode of smaller/local models: the model
 * treats stating its intent as a complete, satisfying answer (finish_reason "stop", empty
 * tool_calls) and genuinely stops there, never following through even across multiple user
 * messages nudging it to continue. This is deliberately narrow (short text + a leading
 * intent-announcing phrase) so a real short answer ("Ja." / "Paris.") is never mistaken for a
 * stall - both regexes must anchor at the START of the trimmed text.
 */
const STALLED_INTENT_RE =
  /^(ich werde|ich will jetzt|ich fange (jetzt )?an|ich beginne (jetzt )?|lass mich|let me|i will|i'll|i am going to|i'm going to)\b/i;
const MAX_STALL_RECOVERY_ATTEMPTS = 2;
const STALL_RECOVERY_NUDGE =
  "Das war noch keine Antwort, sondern nur eine Ankündigung, was du tun wirst. Führe die angekündigte Aktion jetzt tatsächlich aus - rufe das passende Werkzeug auf, oder liefere das eigentliche Ergebnis direkt als Text. Wiederhole nicht nur die Absicht.";
/** Used only on the LAST retry attempt: a plain repeat of STALL_RECOVERY_NUDGE clearly wasn't
 *  enough if the model is still just announcing intent by then, so the final attempt is far more
 *  directive - forbid prose-only output outright rather than asking nicely again. */
const STALL_RECOVERY_FINAL_NUDGE =
  "Du hast bereits zweimal nur angekündigt, etwas zu tun, ohne es zu tun. Antworte in DIESER Nachricht NICHT mit einer Ankündigung. Rufe SOFORT ein Werkzeug auf (z.B. filesystem, browser oder http, je nachdem was die Aufgabe erfordert) oder schreibe das fertige Ergebnis direkt aus. Ein Satz wie \"Ich werde ... durchführen\" ist keine gültige Antwort mehr.";

function looksLikeStalledIntent(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 200 && STALLED_INTENT_RE.test(trimmed);
}

const BUILTIN_BOTS: ReadonlyArray<{ slug: string; name: string; description: string; avatar: string }> = [
  { slug: MAIN_BOT_SLUG, name: "DucKI", description: "Der Standard-Hauptagent für allgemeine Aufgaben.", avatar: "duck-matrix" },
  { slug: CODING_BOT_SLUG, name: "CodingAgent", description: "Spezialisiert auf Code lesen, schreiben und verifizieren.", avatar: "coding-agent" },
];

export interface BotServiceDeps {
  db: DatabaseService;
  /** Same mutable holder buildAgentFactory reads from, so a provider reload is picked up. */
  providerRef: { current: LLMProvider };
  runtimeTools: ToolExecutor[];
  pluginManager: { getTools: () => ToolExecutor[] };
  /** The existing default-agent factory (buildAgentFactory's return value) - reused as-is for
   *  the "main" built-in bot instead of constructing a second, differently-wired Agent. */
  createAgent: () => Promise<Agent>;
  /** The existing CodingAgent factory - reused as-is for the "coding" built-in bot. */
  createCodingAgentFactory: (options?: { sandboxRoot?: string; maxIterations?: number }) => CodingAgent;
}

export interface CreateBotInput {
  name: string;
  description?: string;
  avatar?: string;
  systemPrompt?: string;
  providerId?: string;
  modelId?: string;
  /** Skill access: [] = none, ["*"] = unrestricted, otherwise only listed slugs. */
  skillWhitelist?: string[];
  /** Tool access: [] = none, ["*"] = unrestricted, otherwise only listed names. */
  toolWhitelist?: string[];
}

export type UpdateBotInput = Partial<CreateBotInput>;

/**
 * Custom "bots": user-configured personas built on top of the existing Agent class, plus the two
 * fixed built-in agents (main chat agent, CodingAgent) surfaced as ordinary rows in the same list.
 *
 * No new memory subsystem: each bot gets exactly one persistent home conversation (created lazily
 * on first chat), and MemorySystem's existing conversationId-scoped memories/long-term-recall
 * apply unchanged - the bot's memory simply never mixes with any other conversation.
 */
export class BotService {
  private readonly logger = getRootLogger().child("BotService");

  constructor(private readonly deps: BotServiceDeps) {}

  async ensureBuiltinBots(): Promise<void> {
    for (const builtin of BUILTIN_BOTS) {
      const existing = await this.deps.db.getBot(builtin.slug);
      if (existing) continue;
      await this.deps.db.createBot({
        slug: builtin.slug,
        name: builtin.name,
        description: builtin.description,
        avatar: builtin.avatar,
        systemPrompt: null,
        providerId: null,
        modelId: null,
        skillWhitelist: null,
        toolWhitelist: null,
        isBuiltIn: 1,
        conversationId: null,
      } satisfies Omit<BotInsert, "createdAt" | "updatedAt">);
      this.logger.info("Seeded built-in bot", { slug: builtin.slug });
    }
  }

  async listBots(): Promise<BotSelect[]> {
    return this.deps.db.listBots();
  }

  async getBot(slug: string): Promise<BotSelect | undefined> {
    return this.deps.db.getBot(slug);
  }

  async createBot(input: CreateBotInput): Promise<BotSelect> {
    const name = input.name.trim();
    if (!name) throw new Error("Bot name is required");
    const slug = await this.uniqueSlug(name);
    return this.deps.db.createBot({
      slug,
      name,
      description: input.description?.trim() || null,
      avatar: input.avatar?.trim() || null,
      systemPrompt: input.systemPrompt?.trim() || null,
      providerId: input.providerId?.trim() || null,
      modelId: input.modelId?.trim() || null,
      // New custom bots are fail-closed: omitted/empty lists mean no access. Full access is an
      // explicit wildcard selected by the user. Legacy NULL remains unrestricted when reading.
      skillWhitelist: JSON.stringify(input.skillWhitelist ?? []),
      toolWhitelist: JSON.stringify(input.toolWhitelist ?? []),
      isBuiltIn: 0,
      conversationId: null,
    });
  }

  async updateBot(slug: string, input: UpdateBotInput): Promise<BotSelect> {
    const bot = await this.requireBot(slug);
    if (bot.isBuiltIn) throw new Error("Built-in bots cannot be edited");
    const updated = await this.deps.db.updateBot(slug, {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
      ...(input.avatar !== undefined ? { avatar: input.avatar.trim() || null } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt.trim() || null } : {}),
      ...(input.providerId !== undefined ? { providerId: input.providerId.trim() || null } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId.trim() || null } : {}),
      ...(input.skillWhitelist !== undefined ? { skillWhitelist: JSON.stringify(input.skillWhitelist) } : {}),
      ...(input.toolWhitelist !== undefined ? { toolWhitelist: JSON.stringify(input.toolWhitelist) } : {}),
    });
    if (!updated) throw new Error("Bot not found");
    return updated;
  }

  async deleteBot(slug: string): Promise<void> {
    const bot = await this.requireBot(slug);
    if (bot.isBuiltIn) throw new Error("Built-in bots cannot be deleted");
    await this.deps.db.deleteBot(slug);
    if (bot.conversationId) {
      await this.deps.db.deleteConversation(bot.conversationId);
    }
  }

  /** Resolves (creating on first use) the bot's one persistent home conversation. */
  async resolveConversationId(bot: BotSelect): Promise<number> {
    if (bot.conversationId) return bot.conversationId;
    const conversation = await this.deps.db.createConversation({
      name: `${bot.name}`,
      origin: "bot",
      botId: bot.slug,
    });
    await this.deps.db.updateBot(bot.slug, { conversationId: conversation.id });
    return conversation.id;
  }

  /** True for the two fixed agents, which route to the existing factories instead of a freshly
   *  built Agent - their persona/tool access is not user-configurable through this service. */
  isBuiltinRunnable(slug: string): boolean {
    return slug === MAIN_BOT_SLUG || slug === CODING_BOT_SLUG;
  }

  /**
   * Prepares one non-coding bot for a parallel group-chat batch by loading the shared
   * conversation BEFORE any bot in that batch starts generating. The orchestrator awaits every
   * preparation in the batch as a barrier, so all prepared Agents hold the same pre-round
   * conversation snapshot in memory even though their replies are generated concurrently.
   *
   * CodingAgent intentionally returns undefined: it owns a deeper plan/verify run() wrapper that
   * reloads the conversation itself. The orchestrator therefore isolates the coding bot into a
   * sequential batch instead of pretending it is snapshot-safe.
   */
  async prepareAgentForGroupTurn(bot: BotSelect, conversationId: number): Promise<Agent | undefined> {
    if (bot.slug === CODING_BOT_SLUG) return undefined;
    const agent = await this.createAgentForBot(bot);
    await agent.loadConversation(conversationId);
    return agent;
  }

  /**
   * Sends one message to a bot and returns its reply, plus the DB row id of the persisted
   * assistant message.
   *
   * Without `opts.conversationId` this resolves (and titles) the bot's own persistent home
   * conversation, exactly as before. With it, the bot runs against that conversation instead -
   * used for a shared "bot_chat" group conversation, where several bots take turns in the SAME
   * conversation rather than each having a private one.
   *
   * `opts.preparedAgent` is used only by the group-chat orchestrator after its pre-round barrier.
   * That Agent has already loaded the conversation and must NOT reload it before generation, or
   * same-round replies that happened to finish first would leak into slower peers' context.
   *
   * Every call tags its own resolved assistant row with `authorBotId: bot.slug` - not just for
   * the group-chat UI's avatar/name, but because it is the ONLY reliable "this is the real,
   * final answer" marker available for a bot's turn. Agent.run() persists every intermediate
   * tool-loop iteration as its own role="assistant" row too, and marks ALL of them
   * `metadata.llmOnly` (the interactive chat UI tells those apart from the true final answer via
   * a separate "assistant_text" row written by its live event-stream - a bot run has no event
   * emitter, so that row never exists for it, making `llmOnly` useless as a filter here).
   * `authorBotId`, applied only to the exact row this method itself resolved via
   * runAgentWithRepairRetry's result, is what a chat UI must actually filter on instead.
   *
   * `opts.tagPromptAsInternal`: set by the bot-chat orchestrator, whose `message` is always a
   * synthetic "you were asked to respond because..." directive, never the human's own words - the
   * row it lands in gets `metadata.internal` so a chat UI hides it (same convention as the main
   * chat's own internal follow-up prompts). Left off for a direct 1:1 bot chat, where `message`
   * IS the real, once-only record of what the human typed and must stay visible.
   */
  async chat(
    bot: BotSelect,
    message: string,
    opts?: { conversationId?: number; tagPromptAsInternal?: boolean; preparedAgent?: Agent }
  ): Promise<{ response: string; conversationId: number; messageId?: number; stalled: boolean }> {
    const conversationId = opts?.conversationId ?? (await this.resolveConversationId(bot));
    if (!opts?.conversationId) {
      const conversation = await this.deps.db.getConversation(conversationId);
      if (conversation && conversation.name === bot.name) {
        // First message: give the bot's home conversation a readable title, same as a normal chat.
        await this.deps.db.updateConversation(conversationId, { name: deriveConversationTitle(message) });
      }
    }

    // Non-coding Agent.run() already supports a localMessageId metadata field. Give every hidden
    // bot-orchestrator prompt a unique id and later tag rows by that exact id instead of guessing
    // "the first untagged user row after beforeMaxId". The latter is racy when several bots insert
    // prompts at the same time and could hide another bot's prompt while leaving its own visible.
    const internalPromptLocalId =
      opts?.tagPromptAsInternal && bot.slug !== CODING_BOT_SLUG
        ? `bot-internal-${bot.slug}-${randomUUID()}`
        : undefined;
    const agentRunOptions = internalPromptLocalId ? { localMessageId: internalPromptLocalId } : undefined;

    // CodingAgent does not currently expose localMessageId through its macro run() wrapper.
    // It is deliberately isolated into a sequential batch by BotChatOrchestrator, so the legacy
    // beforeMaxId fallback is deterministic for this one path and no peer can race the lookup.
    let beforeMaxId = 0;
    if (opts?.tagPromptAsInternal && bot.slug === CODING_BOT_SLUG) {
      const beforeHistory = await this.deps.db.getMessages(conversationId);
      beforeMaxId = beforeHistory.length > 0 ? beforeHistory[beforeHistory.length - 1]!.id : 0;
    }

    let response: string;
    if (bot.slug === CODING_BOT_SLUG) {
      const codingAgent = this.deps.createCodingAgentFactory();
      const result = await codingAgent.run(message, { conversationId });
      response = result.summary;
    } else {
      let currentMessage = message;
      let candidate = "";
      const preparedAgent = opts?.preparedAgent;

      const runtimeRetryPrompt = (errorMessage: string, prompt: string) =>
        [
          "The previous run failed with a runtime error.",
          `Error: ${errorMessage}`,
          "Start over from scratch with a fresh solution path.",
          prompt,
        ].join("\n");

      // Bounded retry loop, not just one pass: a stall can recur (the model announces intent,
      // gets nudged, announces intent again) - see STALLED_INTENT_RE's doc comment.
      //
      // Normal 1:1 bot runs preserve the existing fresh-Agent repair behavior. A prepared group
      // turn deliberately reuses its already-loaded Agent across stall/runtime retries: that keeps
      // the immutable pre-round history while still letting the bot see its OWN failed announcement
      // and the recovery nudge. Creating/reloading a fresh Agent mid-round would re-introduce the
      // exact same-round context race the preparation barrier exists to remove.
      for (let attempt = 0; attempt <= MAX_STALL_RECOVERY_ATTEMPTS; attempt++) {
        if (preparedAgent) {
          try {
            const result = await preparedAgent.run(currentMessage, agentRunOptions);
            candidate = result.response;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (!shouldRetryAgentRun(errorMessage)) throw error;
            this.logger.warn("Prepared bot run hit a repairable runtime error; retrying on the frozen Agent", {
              bot: bot.slug,
              error: errorMessage,
            });
            const retryResult = await preparedAgent.run(runtimeRetryPrompt(errorMessage, currentMessage), agentRunOptions);
            candidate = retryResult.response;
          }
        } else {
          const { result } = await runAgentWithRepairRetry(
            () => this.createAgentForBot(bot),
            currentMessage,
            (errorMessage) => runtimeRetryPrompt(errorMessage, currentMessage),
            async (runAgent) => {
              await runAgent.loadConversation(conversationId);
            },
            agentRunOptions
          );
          candidate = result.response;
        }

        if (!looksLikeStalledIntent(candidate)) break;
        if (attempt < MAX_STALL_RECOVERY_ATTEMPTS) {
          this.logger.warn("Bot announced an action without performing it, nudging to continue", {
            bot: bot.slug,
            attempt: attempt + 1,
            announced: candidate,
          });
        }
        // The last retry gets the more forceful nudge - a plain repeat of the same gentle ask
        // clearly hasn't worked if the model is still stalling by then.
        currentMessage = attempt === MAX_STALL_RECOVERY_ATTEMPTS - 1 ? STALL_RECOVERY_FINAL_NUDGE : STALL_RECOVERY_NUDGE;
      }
      response = candidate;
    }

    // True only if every recovery attempt (including the escalated final one) still produced a
    // bare announcement - i.e. genuinely never followed through, not a one-off. Callers that have
    // a "this bot has nothing real to show" convention (the bot-chat orchestrator's pass/hide
    // mechanism) should treat this the same way: per Hermes "Bot Mode"'s own principle, "a failed
    // turn is a pass, never a room error" - showing the false "I will now..." claim as if it were
    // the real answer is worse than showing nothing.
    const stalled = bot.slug !== CODING_BOT_SLUG && looksLikeStalledIntent(response);

    // `response` is written as its OWN new row instead of hunting the existing history for
    // "the last assistant message" and tagging that. That lookup used to be unreliable: if
    // Agent.run()'s loop does anything at all after producing the real answer (another
    // iteration, a nudge, a quality pass that re-generates), a later and often much worse turn
    // becomes "the last assistant row" and gets tagged/shown instead - the actual answer
    // (confirmed correct and complete, `finish_reason: "stop"`, straight from the LLM) stays
    // buried in the raw history, untagged, invisible. Writing a fresh row means what gets shown
    // is always exactly the text this method itself is about to return - the same text every
    // other caller of `chat()` already treats as authoritative (e.g. the 1:1 HTTP endpoint's
    // `data.response`). The raw history still keeps every iteration for the LLM's own context;
    // this is purely the reliable "what a human should see" copy.
    const displayMessage = await this.deps.db.addMessage({
      conversationId,
      role: "assistant",
      content: response,
      authorBotId: bot.slug,
    });

    if (opts?.tagPromptAsInternal) {
      const history = await this.deps.db.getMessages(conversationId);

      if (internalPromptLocalId) {
        // A stall nudge or runtime retry can produce more than one synthetic user row for this
        // bot turn. They intentionally share the same localMessageId, so hide ALL of them.
        const promptRows = history.filter(
          (m) => m.role === "user" && metadataHasLocalMessageId(m.metadata, internalPromptLocalId)
        );
        for (const promptRow of promptRows) {
          await this.deps.db.tagMessage(promptRow.id, {
            metadata: markMetadataInternal(promptRow.metadata),
          });
        }
      } else if (bot.slug === CODING_BOT_SLUG) {
        // Sequential-only fallback for CodingAgent until its macro run() exposes localMessageId.
        const promptRow = history.find((m) => m.id > beforeMaxId && m.role === "user");
        if (promptRow) {
          await this.deps.db.tagMessage(promptRow.id, {
            metadata: markMetadataInternal(promptRow.metadata),
          });
        }
      }
    }

    return { response, conversationId, messageId: displayMessage.id, stalled };
  }

  /** Builds (or reuses) the Agent that should run this bot. Not valid for the "coding" bot,
   *  which uses a differently-shaped CodingAgent - callers must special-case that slug first
   *  (see routes/bots.ts) and call deps.createCodingAgentFactory() instead. */
  async createAgentForBot(bot: BotSelect): Promise<Agent> {
    if (bot.slug === MAIN_BOT_SLUG) return this.deps.createAgent();
    if (bot.slug === CODING_BOT_SLUG) {
      throw new Error("The coding bot must be run via createCodingAgentFactory(), not createAgentForBot()");
    }

    const provider = this.resolveProvider(bot);
    const allowedSkillSlugs = parseAccessList(bot.skillWhitelist);
    const [maxIterationsSetting, timeoutMsSetting] = await Promise.all([
      this.deps.db.getSetting(BOT_AGENT_MAX_ITERATIONS_SETTING),
      this.deps.db.getSetting(BOT_AGENT_TIMEOUT_MS_SETTING),
    ]);
    const agent = new Agent(provider, this.deps.db, undefined, {
      name: bot.name,
      ...(bot.systemPrompt ? { systemPrompt: bot.systemPrompt } : {}),
      ...(allowedSkillSlugs !== undefined ? { allowedSkillSlugs } : {}),
      // Configurable per Settings > Bots instead of only the env-var defaults every other agent
      // falls back to - a bot stuck failing tool calls mid-task (see the filesystem path bug
      // fixed earlier) or doing a genuinely long research task benefits from its own budget
      // independent of the main chat agent's.
      maxIterations: parsePositiveInt(maxIterationsSetting, 50),
      timeoutMs: parsePositiveInt(timeoutMsSetting, 600000),
      // A custom bot's persona (system prompt) is often specifically about tone/length
      // ("always write a thorough report", "answer in one word") - the default agent's internal
      // post-tool-call prompt otherwise always appends "keep it as short as the question needs",
      // which - being the most recent turn - tends to win over an earlier system prompt and
      // flattens every bot's persona to the same terse default style.
      respectPersonaLength: true,
      // A bot's "soul" is its systemPrompt + its own conversation - not the default agent's
      // globally-learned facts (including self-referential ones like its own name) or anything
      // learned in an unrelated chat. Without this a bot could answer "Ich bin DucKI" despite its
      // own systemPrompt saying otherwise, because that came from memory, not from its persona.
      isolatedMemory: true,
      // Reflection/meta-review adds a full extra LLM round-trip after every reply (sometimes two,
      // if it triggers a retry) to critique the response against a generic "helpful assistant"
      // rubric - which for a bot with a specific persona mostly means judging in-character answers
      // as "too generic/formal" and rewriting them toward that generic assistant voice (exactly
      // the kind of rewrite that produced the off-persona "Ich bin @DucKI, was geht so..." retry
      // seen in testing). It's meant for the default assistant, not a scripted persona, and it's
      // also the main latency cost standing between a bot's reply finishing and it becoming
      // visible in a group chat.
      disableQualityPasses: true,
    });

    const allowedToolNames = parseAccessList(bot.toolWhitelist);
    const allowedTools = allowedToolNames === undefined ? undefined : new Set<string>(allowedToolNames);
    const registerScoped = (tool: ToolExecutor) => {
      if (!allowedTools || allowedTools.has(tool.name)) agent.executor.registerTool(tool);
    };
    for (const tool of wrapTools(this.deps.runtimeTools)) registerScoped(tool);
    for (const tool of wrapTools(this.deps.pluginManager.getTools())) registerScoped(tool);

    return agent;
  }

  private resolveProvider(bot: BotSelect): LLMProvider {
    if (!bot.modelId) return this.deps.providerRef.current;
    try {
      return createProvider({ name: (bot.providerId?.trim() || "openrouter") as ProviderName, model: bot.modelId });
    } catch (error) {
      this.logger.warn("Falling back to the default provider for a bot with an unresolvable provider/model", {
        bot: bot.slug,
        providerId: bot.providerId,
        modelId: bot.modelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.deps.providerRef.current;
    }
  }

  private async requireBot(slug: string): Promise<BotSelect> {
    const bot = await this.deps.db.getBot(slug);
    if (!bot) throw new Error("Bot not found");
    return bot;
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "bot";
    let candidate = base;
    let suffix = 2;
    while (await this.deps.db.getBot(candidate)) {
      candidate = `${base}-${suffix++}`;
    }
    return candidate;
  }
}
