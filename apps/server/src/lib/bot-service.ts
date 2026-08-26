import {
  Agent,
  Planner,
  createScopedDiagnosticsTool,
  createScopedFilesystemTool,
  createScopedShellTool,
  formatPlanAsMarkdown,
  type CodingAgent,
} from "@ducki/agent";
import type { BotInsert, BotSelect, DatabaseService } from "@ducki/database";
import type { LLMProvider } from "@ducki/providers";
import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { getRootLogger } from "@ducki/logger";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { wrapTools } from "./tool-wrapper.js";
import { runAgentWithRepairRetry, shouldRetryAgentRun } from "./agent-retry.js";
import { deriveConversationTitle } from "./conversation-title.js";
import { sharedWorkspace } from "./shared-workspace-service.js";
import { loadProviderFromSettings } from "./provider-settings.js";

/** Fixed slugs for the two agents that already exist in this app - seeded once so they show up
 *  as ordinary rows in the bots list/UI alongside user-created bots. */
export const MAIN_BOT_SLUG = "main";
export const CODING_BOT_SLUG = "coding";
export const FRONTEND_DEVELOPER_BOT_SLUG = "frontend-developer";
export const BACKEND_INFRASTRUCTURE_BOT_SLUG = "backend-infrastructure";
export const EXPLORER_BOT_SLUG = "explorer";
export const CODING_SPECIALIST_BOT_SLUGS = new Set([
  FRONTEND_DEVELOPER_BOT_SLUG,
  BACKEND_INFRASTRUCTURE_BOT_SLUG,
]);
export const EDITABLE_SYSTEM_BOT_SLUGS = new Set([...CODING_SPECIALIST_BOT_SLUGS, EXPLORER_BOT_SLUG]);

/** Settings-page keys (Settings > Bots) controlling a single custom bot's own Agent.run() budget
 *  - see BotsSettings.tsx for the matching frontend fields. Falls back to the same defaults the
 *  core Agent class itself uses (AGENT_MAX_ITERATIONS=50, AGENT_TIMEOUT_MS=600000) when unset, so
 *  a bot behaves like the default agent until someone deliberately widens or narrows its budget. */
export const BOT_AGENT_MAX_ITERATIONS_SETTING = "BOT_AGENT_MAX_ITERATIONS";
export const BOT_AGENT_TIMEOUT_MS_SETTING = "BOT_AGENT_TIMEOUT_MS";

/** Settings-page keys (Settings > Bots) controlling the delegate_task subagent tool. */
export const DELEGATION_MAX_CONCURRENT_SETTING = "DELEGATION_MAX_CONCURRENT";
export const DELEGATION_MODEL_SETTING = "DELEGATION_MODEL";

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
  "That was not an answer - it was only an announcement of what you will do. Actually perform the announced action now - call the appropriate tool, or deliver the actual result directly as text. Do NOT just repeat the intent.";
/** Used only on the LAST retry attempt: a plain repeat of STALL_RECOVERY_NUDGE clearly wasn't
 *  enough if the model is still just announcing intent by then, so the final attempt is far more
 *  directive - forbid prose-only output outright rather than asking nicely again. */
const STALL_RECOVERY_FINAL_NUDGE =
  "You have already announced your intent twice without actually doing anything. Do NOT respond with another announcement in THIS message. Call a tool IMMEDIATELY (e.g. filesystem, browser, or http, depending on what the task requires) or write the finished result directly. A sentence like 'I will ...' is no longer a valid answer.";

function looksLikeStalledIntent(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 200 && STALLED_INTENT_RE.test(trimmed);
}

const FRONTEND_DEVELOPER_PROMPT = `You are the frontend specialist for a parent CodingAgent.
Implement the delegated task in the supplied project workspace. Focus on HTML, CSS/SCSS, browser JavaScript/TypeScript, React, responsive design, accessibility, and visual consistency.
Reuse existing components and design tokens. Do not make unrelated backend or infrastructure changes. Inspect files before editing, perform the requested verification where possible, and finish with a concise summary of changed files and checks. Never delegate to another bot.`;

const BACKEND_INFRASTRUCTURE_PROMPT = `You are the backend and project-infrastructure specialist for a parent CodingAgent.
Implement the delegated task in the supplied project workspace. Focus on project/file structure, Node.js, backend TypeScript, PHP, Python, APIs, databases, configuration, and repository-local infrastructure.
Respect the existing architecture and avoid unrelated UI or styling changes. Inspect files before editing, perform the requested verification where possible, and finish with a concise summary of changed files and checks. Never delegate to another bot.`;

const EXPLORER_PROMPT = `Search efficiently: start with grep, glob, or outline, then read only the relevant regions. Prefer exact file paths, symbols, and line numbers. Stop as soon as the specific question is answered. Keep the final report short and factual.`;

const BUILTIN_BOTS: ReadonlyArray<{
  slug: string;
  name: string;
  description: string;
  avatar: string;
  soul?: string;
  systemPrompt?: string;
  skillWhitelist?: string[];
  toolWhitelist?: string[];
}> = [
  { slug: MAIN_BOT_SLUG, name: "DucKI", description: "Der Standard-Hauptagent für allgemeine Aufgaben.", avatar: "duck-matrix", soul: "Du bist DucKI, ein intelligenter KI-Assistent. Du bist hilfsreich, präzise und professionell." },
  { slug: CODING_BOT_SLUG, name: "CodingAgent", description: "Spezialisiert auf Code lesen, schreiben und verifizieren.", avatar: "coding-agent", soul: "Du bist der CodingAgent, ein Spezialist für Code-Analyse, -schreibung und -verifikation. Du bist präzise und gründlich." },
  {
    slug: FRONTEND_DEVELOPER_BOT_SLUG,
    name: "Frontend Developer",
    description: "CodingAgent-Spezialist für CSS, HTML, JavaScript/TypeScript, React, Responsive Design und Accessibility.",
    avatar: "coding-agent",
    systemPrompt: FRONTEND_DEVELOPER_PROMPT,
    skillWhitelist: ["coding-system", "test-driven-development", "code-review"],
    toolWhitelist: ["filesystem", "shell", "git", "diagnostics"],
  },
  {
    slug: BACKEND_INFRASTRUCTURE_BOT_SLUG,
    name: "Backend Infrastructure",
    description: "CodingAgent-Spezialist für Projektstruktur, Node.js, PHP, Python, APIs, Datenbanken und Infrastruktur.",
    avatar: "coding-agent",
    systemPrompt: BACKEND_INFRASTRUCTURE_PROMPT,
    skillWhitelist: ["coding-system", "test-driven-development", "code-review"],
    toolWhitelist: ["filesystem", "shell", "git", "diagnostics"],
  },
  {
    slug: EXPLORER_BOT_SLUG,
    name: "Code Explorer",
    description: "Kurzlebiger, technisch read-only Repository-Suchagent des CodingAgent.",
    avatar: "coding-agent",
    systemPrompt: EXPLORER_PROMPT,
    skillWhitelist: [],
    toolWhitelist: ["filesystem"],
  },
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
  /** Bot's identity/persona text (like hermes SOUL.md). Injected as slot #1 in system prompt. */
  soul?: string;
  systemPrompt?: string;
  providerId?: string;
  modelId?: string;
  /** Skill access: [] = none, ["*"] = unrestricted, otherwise only listed slugs. */
  skillWhitelist?: string[];
  /** Tool access: [] = none, ["*"] = unrestricted, otherwise only listed names. */
  toolWhitelist?: string[];
}

export type UpdateBotInput = Partial<CreateBotInput>;

/** Options for building a bot's Agent instance (see createAgentForBot). */
export interface CreateAgentForBotOptions {
  /** Planning/discussion turn: register NO tools and NO skills - enforced at runtime, not just in the prompt. */
  noTools?: boolean;
  /** Hermes "bot_mode_protocol": teammate roster + messaging protocol appended to the system prompt. */
  groupProtocol?: string;
  /** Leaf subagent spawned by delegate_task: must not be able to delegate again. */
  isSubagent?: boolean;
  /** Optional model override (delegate_task workers via DELEGATION_MODEL). */
  modelId?: string;
}

/** Options for a single bot turn (BotService.chat). */
export interface BotChatOptions {
  conversationId?: number;
  tagPromptAsInternal?: boolean;
  preparedAgent?: Agent;
  codingContext?: { sandboxRoot: string };
  noTools?: boolean;
  groupProtocol?: string;
  isSubagent?: boolean;
  onEvent?: (event: { type: string; message: string; data?: Record<string, unknown> }) => void;
}

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
        soul: builtin.soul ?? null,
        systemPrompt: builtin.systemPrompt ?? null,
        providerId: null,
        modelId: null,
        skillWhitelist: builtin.skillWhitelist ? JSON.stringify(builtin.skillWhitelist) : null,
        toolWhitelist: builtin.toolWhitelist ? JSON.stringify(builtin.toolWhitelist) : null,
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
      soul: input.soul?.trim() || null,
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
    if (bot.isBuiltIn && !EDITABLE_SYSTEM_BOT_SLUGS.has(bot.slug)) {
      throw new Error("Built-in bots cannot be edited");
    }
    const updated = await this.deps.db.updateBot(slug, {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
      ...(input.avatar !== undefined ? { avatar: input.avatar.trim() || null } : {}),
      ...(input.soul !== undefined ? { soul: input.soul.trim() || null } : {}),
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

  /** Returns the editable profile used by the disposable read-only explorer. Tool access is
   * intentionally not returned: explore-tool enforces its one read-only filesystem tool in code. */
  async resolveExplorerProfile(): Promise<{
    provider: LLMProvider;
    systemPrompt?: string;
    allowedSkillSlugs?: string[];
  } | undefined> {
    const bot = await this.deps.db.getBot(EXPLORER_BOT_SLUG);
    if (!bot) return undefined;
    const allowedSkillSlugs = parseAccessList(bot.skillWhitelist);
    return {
      provider: await this.resolveProvider(bot),
      ...(bot.systemPrompt ? { systemPrompt: bot.systemPrompt } : {}),
      ...(allowedSkillSlugs !== undefined ? { allowedSkillSlugs } : {}),
    };
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
  async prepareAgentForGroupTurn(
    bot: BotSelect,
    conversationId: number,
    options?: { groupProtocol?: string; noTools?: boolean }
  ): Promise<Agent | undefined> {
    if (bot.slug === CODING_BOT_SLUG) return undefined;
    const agent = await this.createAgentForBot(bot, undefined, options);
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
    opts?: BotChatOptions
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
    const agentRunOptions = {
      ...(internalPromptLocalId ? { localMessageId: internalPromptLocalId, displayContent: `[Delegated to ${bot.name}]` } : {}),
      ...(opts?.onEvent ? { onEvent: opts.onEvent } : {}),
      // A planning/discussion turn runs in chatbot mode as an extra iteration cap on top of
      // the hard tool-strip in createAgentForBot (noTools).
      ...(opts?.noTools ? { agentMode: "chatbot" as const } : {}),
    };

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
            () => this.createAgentForBot(bot, opts?.codingContext, {
              noTools: opts?.noTools,
              groupProtocol: opts?.groupProtocol,
              isSubagent: opts?.isSubagent,
            }),
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

  /**
   * Runs a delegated specialist in a fresh, disposable conversation.
   *
   * A coding delegation must never load the specialist bot's persistent home chat: that history
   * may contain unrelated user work and would then contaminate the parent CodingAgent through the
   * returned tool result. The temporary conversation is also deleted after the synchronous reply,
   * so no auxiliary bot message can surface in the Coding UI or later quality passes.
   */
  async chatIsolated(
    bot: BotSelect,
    message: string,
    codingContext?: { sandboxRoot: string }
  ): Promise<{ response: string; stalled: boolean }> {
    const conversation = await this.deps.db.createConversation({
      name: `Delegation: ${bot.name}`,
      origin: "coding_agent",
    });
    try {
      const result = await this.chat(bot, message, {
        conversationId: conversation.id,
        ...(codingContext ? { codingContext } : {}),
      });
      return { response: result.response, stalled: result.stalled };
    } finally {
      await this.deps.db.deleteConversation(conversation.id);
    }
  }

  /** Builds (or reuses) the Agent that should run this bot. Not valid for the "coding" bot,
   *  which uses a differently-shaped CodingAgent - callers must special-case that slug first
   *  (see routes/bots.ts) and call deps.createCodingAgentFactory() instead. */
  async createAgentForBot(
    bot: BotSelect,
    codingContext?: { sandboxRoot: string },
    options: CreateAgentForBotOptions = {}
  ): Promise<Agent> {
    // The "main" bot normally reuses the shared default agent factory (full tools, special
    // wiring in index.ts). Three cases must NOT do that: a planning/discussion turn (options.
    // noTools - the whole point is tools disabled at runtime, see Part 2 of the team design), a
    // delegate_task subagent (options.isSubagent - it must never delegate again, Part 3), and a
    // group/team chat turn (options.groupProtocol - main must get the bot-to-bot protocol baked
    // into its system prompt and the message_agent/delegate_task tools like every other
    // participant, or it can't act as a peer bot in the conversation).
    // In all three cases main is built as an ordinary scoped Agent like any custom bot.
    if (bot.slug === MAIN_BOT_SLUG && !options.noTools && !options.isSubagent && !options.groupProtocol) {
      return this.deps.createAgent();
    }
    if (bot.slug === CODING_BOT_SLUG) {
      throw new Error("The coding bot must be run via createCodingAgentFactory(), not createAgentForBot()");
    }

    const provider = await this.resolveProvider(bot, options.modelId);
    // A planning/discussion turn must never be able to call tools or load skills - the
    // "do not use tools" instruction is enforced at the runtime level here, not only in the
    // prompt (see buildDelegatedPrompt in bot-chat-orchestrator.ts).
    const allowedSkillSlugs = options.noTools ? [] : parseAccessList(bot.skillWhitelist);
    const [maxIterationsSetting, timeoutMsSetting] = await Promise.all([
      this.deps.db.getSetting(BOT_AGENT_MAX_ITERATIONS_SETTING),
      this.deps.db.getSetting(BOT_AGENT_TIMEOUT_MS_SETTING),
    ]);
    const workspaceDirective = codingContext
      ? `\n\n## Delegated coding workspace\nThe project root is exactly: ${codingContext.sandboxRoot}\nFor every filesystem call, set basePath to that exact project root and use paths relative to it. Never read or write outside it.`
      : "";
    // Team/group chats inject the bot-to-bot messaging protocol (roster, @mentions, pass,
    // @user escalation) into the SYSTEM PROMPT at agent-build time - the Hermes
    // "bot_mode_protocol" pattern - so it is persistent context, not just a per-message nudge.
    const systemPrompt = [bot.systemPrompt ?? "", workspaceDirective, options.groupProtocol ?? ""]
      .filter(Boolean)
      .join("\n")
      .trim();
    const agent = new Agent(provider, this.deps.db, undefined, {
      name: bot.name,
      // Soul is the bot's identity (slot #1 in system prompt)
      ...(bot.soul ? { soul: bot.soul } : {}),
      // System prompt is project-specific instructions + workspace + group protocol (slots #2+)
      ...(systemPrompt ? { systemPrompt } : {}),
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

    const allowedToolNames = options.noTools ? [] : parseAccessList(bot.toolWhitelist);
    const allowedTools = allowedToolNames === undefined ? undefined : new Set<string>(allowedToolNames);
    const registerScoped = (tool: ToolExecutor) => {
      if (!allowedTools || allowedTools.has(tool.name)) agent.executor.registerTool(tool);
    };
    const runtimeTools = codingContext
      ? this.deps.runtimeTools.map((tool) => {
          if (tool.name === "filesystem") return createScopedFilesystemTool(codingContext.sandboxRoot);
          if (tool.name === "shell") return createScopedShellTool(codingContext.sandboxRoot);
          if (tool.name === "diagnostics") return createScopedDiagnosticsTool(codingContext.sandboxRoot);
          if (tool.name === "git") {
            return {
              ...tool,
              async execute(input: Record<string, unknown>) {
                const action = String(input["action"] ?? "");
                if (!["status", "diff", "log"].includes(action)) {
                  return { success: false, data: null, error: "Delegated specialists have read-only git access." };
                }
                return tool.execute({ ...input, path: codingContext.sandboxRoot });
              },
            } satisfies ToolExecutor;
          }
          return tool;
        })
      : this.deps.runtimeTools;
    for (const tool of wrapTools(runtimeTools)) registerScoped(tool);
    for (const tool of wrapTools(this.deps.pluginManager.getTools())) registerScoped(tool);

    // Part 3 (Hermes parity) - bot-to-bot messaging: inside a team/group chat every participant
    // gets message_agent so it can DM a teammate directly. Outside group context (no
    // groupProtocol) the tool is not registered.
    if (options.groupProtocol && !options.noTools) {
      agent.executor.registerTool(this.buildMessageAgentTool(bot));
    }
    // Part 3 (Hermes parity) - delegate_task: any bot that is itself a full agent (not a coding
    // worker, not a leaf subagent, not the read-only explorer) may spawn isolated subagents
    // with its inherited tool whitelist - and a subagent can never delegate further (no
    // recursion).
    if (!options.noTools && !options.isSubagent && !CODING_SPECIALIST_BOT_SLUGS.has(bot.slug) && bot.slug !== EXPLORER_BOT_SLUG) {
      agent.executor.registerTool(this.buildDelegateTaskTool(bot));
    }

    return agent;
  }

  private async resolveProvider(bot: BotSelect, modelOverride?: string): Promise<LLMProvider> {
    const model = modelOverride?.trim() || bot.modelId;
    if (!model) return this.deps.providerRef.current;
    try {
      // Go through the same settings-backed resolution the main chat agent uses (baseUrl,
      // apiKey per provider) instead of a bare createProvider(), which has no baseUrl/apiKey
      // and silently points a custom-provider bot at the hardcoded default endpoint with no
      // credentials.
      const { provider } = await loadProviderFromSettings(this.deps.db, {
        providerName: bot.providerId?.trim() || undefined,
        model,
      });
      return provider;
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

  /**
   * Part 3 (Hermes parity) - message_agent: fire-and-forget bot-to-bot DM delivered into the
   * target's canonical home chat, with attribution. The sender gets an acknowledgement and
   * finishes its turn; the reply arrives later as a background turn in the sender's chat.
   */
  async deliverBotMessage(
    senderBot: BotSelect,
    targetSlug: string,
    message: string
  ): Promise<{ delivered: boolean; error?: string }> {
    const target = await this.getBot(targetSlug);
    if (!target) return { delivered: false, error: `No bot with slug '${targetSlug}'.` };
    const attributed = `Message from 🤖 ${senderBot.name} (@${senderBot.slug}): ${message}`;
    void this.chat(target, attributed)
      .then((result) =>
        this.logger.info("Bot DM delivered", {
          from: senderBot.slug,
          to: targetSlug,
          response: result.response.slice(0, 80),
        })
      )
      .catch((error) =>
        this.logger.warn("Bot DM delivery failed", {
          from: senderBot.slug,
          to: targetSlug,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    return { delivered: true };
  }

  private buildMessageAgentTool(bot: BotSelect): ToolExecutor {
    const service = this;
    return {
      name: "message_agent",
      description:
        "Send a direct message to a teammate bot (they receive it in their own chat, attributed to you). Fire-and-forget: you get an acknowledgement now, their reply arrives later in this chat.",
      definition: {
        name: "message_agent",
        description: "Message another bot directly.",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string", description: "The teammate's bot slug (e.g. \"eddy\")." },
            message: { type: "string", description: "The message to deliver verbatim." },
          },
          required: ["target", "message"],
        },
      },
      async execute(input: Record<string, unknown>): Promise<ToolResult> {
        const target = String(input["target"] ?? "").trim();
        const message = String(input["message"] ?? "").trim();
        if (!target) return { success: false, data: null, error: "message_agent: 'target' (bot slug) is required." };
        if (!message) return { success: false, data: null, error: "message_agent: 'message' is required." };
        const outcome = await service.deliverBotMessage(bot, target, message);
        return outcome.delivered
          ? { success: true, data: { status: "delivered", to: target } }
          : { success: false, data: null, error: outcome.error ?? "Delivery failed." };
      },
    };
  }

  /**
   * Part 3 (Hermes parity) - delegate_task: spawn isolated subagents (fresh conversation, no
   * memory of the caller) to complete goal+context tasks and wait for their summaries. Supports
   * a tasks array for parallel batches; results come back in input order. A subagent inherits
   * the caller bot's tool whitelist and can never delegate further (leaf, see createAgentForBot).
   */
  async delegateTask(
    bot: BotSelect,
    tasks: Array<{ goal: string; context?: string }>,
    options: { maxConcurrent?: number } = {}
  ): Promise<Array<{ goal: string; response: string; stalled: boolean }>> {
    const [concurrencySetting, modelSetting] = await Promise.all([
      this.deps.db.getSetting(DELEGATION_MAX_CONCURRENT_SETTING),
      this.deps.db.getSetting(DELEGATION_MODEL_SETTING),
    ]);
    const maxConcurrent = Math.max(1, options.maxConcurrent ?? parsePositiveInt(concurrencySetting, 3));
    const modelOverride = modelSetting?.trim() || undefined;

    const results: Array<{ goal: string; response: string; stalled: boolean }> = new Array(tasks.length);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < tasks.length) {
        const index = cursor++;
        const task = tasks[index]!;
        const conversation = await this.deps.db.createConversation({
          name: `Delegation: ${bot.name}`,
          origin: "delegation",
        });
        try {
          const agent = await this.createAgentForBot(bot, undefined, { isSubagent: true, modelId: modelOverride });
          await agent.loadConversation(conversation.id);
          const prompt = task.context ? `${task.context}\n\n${task.goal}` : task.goal;
          const result = await agent.run(prompt);
          results[index] = { goal: task.goal, response: result.response, stalled: false };
        } catch (error) {
          results[index] = {
            goal: task.goal,
            response: `Subagent error: ${error instanceof Error ? error.message : String(error)}`,
            stalled: true,
          };
        } finally {
          await this.deps.db.deleteConversation(conversation.id).catch(() => {});
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(maxConcurrent, tasks.length) }, () => worker()));
    return results;
  }

  private buildDelegateTaskTool(bot: BotSelect): ToolExecutor {
    const service = this;
    return {
      name: "delegate_task",
      description:
        "Spawn isolated subagent(s) with a completely FRESH context to complete a task and wait for the summary. Subagents know nothing about this conversation - pass everything they need via goal + context. Pass tasks=[...] to run several in parallel (results come back in input order).",
      definition: {
        name: "delegate_task",
        description: "Run task(s) in isolated subagents and wait for their summaries.",
        parameters: {
          type: "object",
          properties: {
            goal: { type: "string", description: "The task for the subagent (required unless using tasks)." },
            context: { type: "string", description: "All context the subagent needs - it has no memory of this conversation." },
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: { goal: { type: "string" }, context: { type: "string" } },
              },
              description: "Alternative to goal: run several tasks in parallel.",
            },
            maxConcurrent: { type: "number", description: "Max parallel subagents (default 3)." },
          },
        },
      },
      async execute(input: Record<string, unknown>): Promise<ToolResult> {
        const rawTasks = Array.isArray(input["tasks"]) ? input["tasks"] : [];
        const tasks: Array<{ goal: string; context?: string }> = [];
        if (rawTasks.length > 0) {
          for (const item of rawTasks) {
            if (!item || typeof item !== "object") continue;
            const goal = String((item as Record<string, unknown>)["goal"] ?? "").trim();
            const context = String((item as Record<string, unknown>)["context"] ?? "").trim();
            if (goal) tasks.push({ goal, ...(context ? { context } : {}) });
          }
        } else {
          const goal = String(input["goal"] ?? "").trim();
          const context = String(input["context"] ?? "").trim();
          if (goal) tasks.push({ goal, ...(context ? { context } : {}) });
        }
        if (tasks.length === 0) {
          return { success: false, data: null, error: "delegate_task requires 'goal' (or a non-empty 'tasks' array)." };
        }
        const rawConcurrent = Number(input["maxConcurrent"]);
        const results = await service.delegateTask(bot, tasks, {
          maxConcurrent: Number.isFinite(rawConcurrent) && rawConcurrent > 0 ? Math.round(rawConcurrent) : undefined,
        });
        return {
          success: true,
          data: {
            results: results.map((result, index) => ({
              index,
              goal: result.goal,
              response: result.response,
              failed: result.stalled,
            })),
          },
        };
      },
    };
  }

  /**
   * Part 2 (brainstorm) - convergence: after the discussion rounds settle, synthesize the
   * exchange into a concrete, structured plan (Planner) and persist it as a markdown artifact
   * in the group's shared workspace. Returns the plan text (also written as an assistant
   * message authored by $authorBot, so the room transcript ends with the plan).
   */
  async synthesizeTeamPlan(
    goal: string,
    conversationId: number,
    authorBot: BotSelect
  ): Promise<{ content: string; path: string; messageId?: number }> {
    const planner = new Planner(this.deps.providerRef.current, this.logger);
    const plan = await planner.createPlan(goal, []);
    const markdown = formatPlanAsMarkdown(plan);

    const workspaceDir = sharedWorkspace.resolveGroupWorkspace(conversationId);
    const outputDir = join(workspaceDir, "output");
    const archiveDir = join(outputDir, "archive");
    await mkdir(archiveDir, { recursive: true });
    const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plan";
    const path = join(outputDir, `plan-${slug}-${Date.now()}.md`);

    // A new planning exchange supersedes the previously-active plan: move every old plan-*.md
    // out of output/ (so findActivePlan only ever sees the current one) and tag their transcript
    // rows as archived so the chat UI shows them as superseded instead of still active.
    await this.archiveSupersededPlans(conversationId, path);

    await writeFile(path, markdown, "utf8");

    const content = `## 📋 Gemeinsamer Plan\n\n${markdown}\n\n_Plan gespeichert: ${path}_`;
    const message = await this.deps.db.addMessage({
      conversationId,
      role: "assistant",
      content,
      authorBotId: authorBot.slug,
      // Marks this row as the group's plan artifact so chat UIs can render it as a plan card and
      // pin the latest one as the "active plan" (see BotChatRoom.tsx). planPath is the absolute
      // markdown file in the group's shared workspace that execution rounds read back.
      metadata: JSON.stringify({ plan: true, planPath: path }),
    });
    return { content, path, messageId: message.id };
  }

  /**
   * Plan lifecycle: moves superseded plan artifacts (every output/plan-*.md except the new one)
   * into output/archive/ and marks their transcript rows with metadata.archived - so exactly one
   * plan stays "active" at a time, namely the one findActivePlan picks up for execution.
   */
  private async archiveSupersededPlans(conversationId: number, newPlanPath: string): Promise<void> {
    const workspaceDir = sharedWorkspace.resolveGroupWorkspace(conversationId);
    const outputDir = join(workspaceDir, "output");
    const archiveDir = join(outputDir, "archive");
    try {
      const entries = await readdir(outputDir, { withFileTypes: true });
      const archivedPaths: string[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith("plan-") || !entry.name.endsWith(".md")) continue;
        const from = join(outputDir, entry.name);
        if (from === newPlanPath) continue;
        await rename(from, join(archiveDir, entry.name));
        archivedPaths.push(from);
      }
      if (archivedPaths.length === 0) return;

      const messages = await this.deps.db.getMessages(conversationId);
      for (const message of messages) {
        if (message.role !== "assistant" || !message.metadata) continue;
        try {
          const meta = JSON.parse(message.metadata) as { plan?: boolean; planPath?: string };
          if (meta.plan && typeof meta.planPath === "string" && archivedPaths.includes(meta.planPath)) {
            await this.deps.db.tagMessage(message.id, { metadata: JSON.stringify({ ...meta, archived: true }) });
          }
        } catch {
          // ignore malformed metadata
        }
      }
    } catch (error) {
      this.logger.warn("Could not archive superseded plans", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
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
