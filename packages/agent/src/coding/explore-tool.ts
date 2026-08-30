import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { LLMProvider } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import { filesystemTool } from "@ducki/tools";
import { Agent, TOOL_CALL_FORMAT_BLOCK } from "../agent.js";
import { createScopedFilesystemTool } from "./scoped-filesystem-tool.js";

const EXPLORE_DIRECTIVE = `You are a read-only code explorer. You answer ONE question about a codebase and nothing else.

You have exactly one tool: filesystem, and only its read-only actions - grep, glob, list, read, stat, exists.
You cannot and must not modify anything.

How to work:
1. Start with grep or glob to narrow down WHERE the answer lives. Never read files speculatively.
2. Read only the parts you actually need, and read several files in ONE response when they are independent.
3. Stop as soon as you can answer. You are being used precisely because you are cheap - do not explore further than the question requires.

Your final answer must be SHORT and CONCRETE: the file paths, the line numbers, and the few lines that matter.
Do not paste whole files. Do not summarise the architecture. Do not suggest changes.
If you could not find it, say so plainly and name where you looked.`;

/** Read-only subset of the filesystem tool. An explorer that could write would be a second,
 *  unsupervised editor operating outside the read-before-edit discipline and outside the
 *  checkpoint trail - so the actions are removed from the schema, not merely discouraged. */
function createReadOnlyFilesystemTool(sandboxRoot: string | undefined): ToolExecutor {
  const base = sandboxRoot ? createScopedFilesystemTool(sandboxRoot) : filesystemTool;
  const allowed = new Set(["read", "list", "glob", "grep", "stat", "exists", "outline"]);

  const definition = JSON.parse(JSON.stringify(base.definition)) as typeof base.definition;
  const properties = definition.parameters?.properties as Record<string, { enum?: string[]; description?: string }> | undefined;
  if (properties?.["action"]) {
    properties["action"].enum = [...allowed];
    properties["action"].description = "Read-only operation: read, list, glob, grep, stat, exists, outline.";
  }

  return {
    name: base.name,
    description: `${base.description} (read-only)`,
    definition,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = String(input["action"] ?? "").toLowerCase();
      if (!allowed.has(action)) {
        return {
          success: false,
          data: null,
          error: `'${action}' is not available here - this is a read-only exploration. Allowed: ${[...allowed].join(", ")}.`,
        };
      }
      return base.execute(input);
    },
  };
}

/** The only tools an exploration may hold. `submit_solution` is kept because it is the run
 *  loop's explicit "I am done" path; everything else is stripped (see below). */
const EXPLORER_TOOLS: ReadonlySet<string> = new Set(["filesystem", "submit_solution"]);

// Deliberately narrow to unambiguous IMPERATIVE verbs only ("list X", "read X", "cat X", ...) -
// NOT phrasings like "what's in X?" or "what is X?". Those read as simple lookups to a human but
// are indistinguishable, by verb alone, from a genuine open-ended question ("what is the routing
// convention here?") that legitimately needs the sub-agent's reasoning - misreading one of those
// as a bare path lookup would silently return the wrong kind of answer instead of the real one.
const LIST_INTENT = /^(?:list|ls|dir)\b/i;
const READ_INTENT = /^(?:read|cat|show(?:\s+me)?|view|display|open)\b/i;

/**
 * Pulls a single bare path token out of a short, literal "list X" / "read X" question, or
 * returns undefined if the question doesn't reduce to exactly one. A real relative path never
 * contains whitespace in this codebase's projects; a genuine open-ended question ("where is the
 * login handler defined?") almost always does - that asymmetry is what keeps this conservative:
 * anything that doesn't collapse to one clean token falls through to the LLM sub-agent below
 * instead of being misread as a path.
 */
function extractPathCandidate(question: string): string | undefined {
  let cleaned = question.trim().replace(/[?!.]+$/, "").trim();
  cleaned = cleaned.replace(/^["'`]|["'`]$/g, "").trim();
  cleaned = cleaned.replace(/^(?:read|cat|show(?:\s+me)?|view|display|open|list|ls|dir)\s+/i, "");
  cleaned = cleaned.replace(/^(?:the\s+)?(?:contents?\s+of\s+)?(?:the\s+)?(?:file|directory|folder|dir)\s+/i, "").trim();

  const quoted = cleaned.match(/["'`]([^"'`]+)["'`]/);
  const candidate = (quoted?.[1] ?? cleaned).replace(/[.,;:]+$/, "").trim();

  if (!candidate || /\s/.test(candidate)) return undefined;
  if (!/^[\w.][\w./-]*$/.test(candidate)) return undefined;
  return candidate;
}

function formatDeterministicAnswer(path: string, data: unknown): string {
  if (typeof data === "string") {
    return `Contents of ${path}:\n${data}`;
  }
  const entries = Array.isArray(data)
    ? (data as Array<{ name: string; type: string }>)
    : Array.isArray((data as { entries?: unknown })?.entries)
      ? ((data as { entries: Array<{ name: string; type?: string }> }).entries)
      : undefined;
  if (entries) {
    const lines = entries.map((e) => `${e.type === "directory" ? "[dir] " : ""}${e.name}`);
    return `Contents of directory ${path}:\n${lines.join("\n") || "(empty)"}`;
  }
  return `Contents of ${path}:\n${JSON.stringify(data)}`;
}

/**
 * Answers a literal "list <path>" / "read <path>" exploration question with a single
 * deterministic filesystem call - no LLM sub-agent, no extra request. This is deliberately
 * narrow: it only fires when the question reduces to one unambiguous verb + one bare path
 * token (see extractPathCandidate). Anything else - real search/reasoning questions, which are
 * the vast majority of explore calls per EXPLORE_DIRECTIVE's own guidance - falls through to
 * the sub-agent below completely unchanged.
 *
 * "read" is tried even for a directory-shaped question ("what's in X") because the underlying
 * filesystem tool already degrades a read-on-a-directory into the same listing "list" would
 * give (see filesystem.ts's read case) - no need to pre-classify file vs. directory ourselves.
 * "list" on an actual file fails with a clear, recognizable error, which is retried once as a
 * read instead of being treated as a dead end.
 */
async function tryDeterministicAnswer(
  question: string,
  fsTool: ToolExecutor
): Promise<{ answer: string } | undefined> {
  const trimmed = question.trim();
  const isListIntent = LIST_INTENT.test(trimmed);
  const isReadIntent = !isListIntent && READ_INTENT.test(trimmed);
  if (!isListIntent && !isReadIntent) return undefined;

  const path = extractPathCandidate(trimmed);
  if (!path) return undefined;

  let result = await fsTool.execute({ action: isListIntent ? "list" : "read", path });
  if (!result.success && isListIntent && /is a file, not a directory/i.test(result.error ?? "")) {
    result = await fsTool.execute({ action: "read", path });
  }
  if (!result.success || result.data == null) return undefined;

  return { answer: formatDeterministicAnswer(path, result.data) };
}

export interface ExploreToolOptions {
  sandboxRoot?: string;
  /** Optional per-call profile. This keeps the explorer disposable while allowing its provider,
   * persona and skill access to be improved through an external bot profile. */
  resolveProfile?: () => Promise<{
    provider?: LLMProvider;
    systemPrompt?: string;
    allowedSkillSlugs?: string[];
    maxIterations?: number;
    timeoutMs?: number;
  } | undefined>;
  /** Iteration budget for one exploration. Kept small on purpose - see the tool description. */
  maxIterations?: number;
  /**
   * Hard wall-clock budget for ONE exploration, in milliseconds. The sub-agent's own
   * progress timeout only fires on INACTIVITY (it re-arms on every event), so a stuck-but-
   * busy explorer could otherwise hold the main coding run hostage for its whole iteration
   * budget. Racing the run against this deadline - and aborting the sub-agent when it wins -
   * bounds how long an explore call can block the caller. Default: DUCKI_EXPLORE_TIMEOUT_MS
   * or 3 minutes.
   */
  timeoutMs?: number;
}

/**
 * Delegates a search to a throwaway sub-agent with its own context.
 *
 * Exploration is what makes a coding run expensive: locating the right place in an unfamiliar
 * codebase can take a dozen greps and reads, and every one of those results then sits in the
 * main conversation for the REST of the run, re-sent and re-billed on every subsequent
 * iteration - even though only the one-line conclusion ("the handler is in routes/x.ts:88")
 * still matters.
 *
 * The sub-agent burns that context in a conversation that is discarded when it returns, and only
 * its answer comes back. It also runs without persistence, so an exploration leaves no rows in
 * the user's conversation history.
 */
export function createExploreTool(
  provider: LLMProvider,
  db: DatabaseService,
  options: ExploreToolOptions = {}
): ToolExecutor {
  return {
    name: "explore",
    description: "Delegate a codebase search to a read-only sub-agent; get back a short answer.",
    definition: {
      name: "explore",
      description:
        "Ask a read-only sub-agent to find something in the codebase and report back briefly. Use this when " +
        "locating something will take several greps and reads - the search happens in a separate context, so " +
        "only the answer costs you tokens, not the dozen file dumps it took to get there. Ask ONE specific " +
        "question ('which file registers the coding routes, and on which line?'). Do NOT use it when you " +
        "already know the file - just read that file. Do NOT use it to make changes; it cannot.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "One specific question about the codebase. Include what you already know, so the sub-agent does " +
              "not re-derive it.",
          },
        },
        required: ["question"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const question = String(input["question"] ?? "").trim();
      if (!question) {
        return { success: false, data: null, error: "question required, e.g. \"where is the coding router mounted?\"" };
      }

      // A literal "list <path>" / "read <path>" question needs no LLM at all - answer it with
      // one deterministic filesystem call instead of spinning up a whole sub-agent conversation.
      // This is what keeps a batch of several such explore calls (the model is free to issue
      // more than one per turn - see agent.ts's parallel tool-batch execution) from turning into
      // that many CONCURRENT LLM requests to the provider; a real search/reasoning question
      // (the normal case) is unaffected and falls straight through to the sub-agent below.
      const readOnlyFs = createReadOnlyFilesystemTool(options.sandboxRoot);
      const deterministic = await tryDeterministicAnswer(question, readOnlyFs);
      if (deterministic) {
        return { success: true, data: { question, answer: deterministic.answer, iterations: 0, deterministic: true } };
      }

      const profile = await options.resolveProfile?.();
      const rootHint = options.sandboxRoot
        ? `\n\nProject root: ${options.sandboxRoot}. Address every path RELATIVE to it.`
        : "";

      const persona = profile?.systemPrompt?.trim()
        ? `${EXPLORE_DIRECTIVE}\n\n## Custom explorer guidance\n${profile.systemPrompt.trim()}`
        : EXPLORE_DIRECTIVE;
      const subAgent = new Agent(profile?.provider ?? provider, db, undefined, {
        name: "Explorer",
        systemPrompt: `${persona}${rootHint}\n\n${TOOL_CALL_FORMAT_BLOCK}`,
        maxIterations: profile?.maxIterations ?? options.maxIterations ?? 12,
        ...(profile?.allowedSkillSlugs ? { allowedSkillSlugs: profile.allowedSkillSlugs } : {}),
        disableQualityPasses: true,
      });
      subAgent.executor.registerTool(readOnlyFs);

      // Strip everything the Agent constructor auto-registers (memory, project, task, history,
      // gateway, vision, script and plan tools). Two reasons, both disqualifying:
      //
      // 1. Correctness. This is documented and prompted as a READ-ONLY explorer, and the
      //    filesystem tool it gets has its writing actions removed to enforce that - but
      //    `gateway` sends outbound messages to Discord/Telegram and the script tools execute
      //    code, so an exploration could have side effects the caller was promised it cannot have.
      // 2. Cost. The whole point of delegating a search is that it is cheap. Those tool
      //    descriptions go into the sub-agent's system prompt on every one of its iterations,
      //    which is precisely the overhead this tool exists to avoid.
      for (const tool of subAgent.executor.listTools()) {
        if (!EXPLORER_TOOLS.has(tool.name)) subAgent.executor.unregisterTool(tool.name);
      }

      // No startConversation(): without a conversation id the ConversationManager keeps
      // everything in memory and writes nothing to the database, which is exactly what a
      // throwaway context should do.
      const runPromise = subAgent.run(question);
      // Mark the promise handled even after the timeout below has already won the race, so a
      // late rejection (the aborted sub-agent unwinding) never surfaces as unhandled.
      void runPromise.catch(() => {});

      const timeoutMs = profile?.timeoutMs ?? options.timeoutMs ?? 180_000;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Exploration timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      });

      try {
        const result = await Promise.race([runPromise, deadline]);
        // The sub-agent shares the run loop's non-convergence guardrail, so a model stuck
        // re-reading the same files aborts itself (abortedReason "stale_read_loop") instead of
        // burning all 12 iterations. That abort produced no answer worth returning - surface it
        // as a failure so the MAIN agent knows the search did not happen and greps itself.
        if (result.abortedReason) {
          return {
            success: false,
            data: null,
            error:
              result.abortedReason === "stale_read_loop"
                ? `Exploration was stopped: it repeated identical read-only calls without progress (loop detected). Search yourself with filesystem grep/glob instead.`
                : `Exploration was stopped early (${result.abortedReason}). Search yourself with filesystem grep/glob instead.`,
          };
        }
        return {
          success: true,
          data: {
            question,
            answer: result.response,
            iterations: result.iterations,
          },
        };
      } catch (error) {
        // The deadline won the race: abort the sub-agent's in-flight LLM call so its run loop
        // unwinds instead of leaking, then tell the main agent to do the search itself.
        subAgent.stop();
        const message = error instanceof Error ? error.message : String(error);
        if (/timed out after/.test(message)) {
          return {
            success: false,
            data: null,
            error: `${message}. Search yourself with filesystem grep/glob instead.`,
          };
        }
        return {
          success: false,
          data: null,
          error: `Exploration failed: ${message}. Search yourself with filesystem grep/glob instead.`,
        };
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
  };
}
