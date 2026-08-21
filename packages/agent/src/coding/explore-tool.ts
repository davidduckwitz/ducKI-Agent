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

export interface ExploreToolOptions {
  sandboxRoot?: string;
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

      const rootHint = options.sandboxRoot
        ? `\n\nProject root: ${options.sandboxRoot}. Address every path RELATIVE to it.`
        : "";

      const subAgent = new Agent(provider, db, undefined, {
        name: "Explorer",
        systemPrompt: `${EXPLORE_DIRECTIVE}${rootHint}\n\n${TOOL_CALL_FORMAT_BLOCK}`,
        maxIterations: options.maxIterations ?? 12,
        disableQualityPasses: true,
      });
      subAgent.executor.registerTool(createReadOnlyFilesystemTool(options.sandboxRoot));

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

      const timeoutMs = options.timeoutMs ?? 180_000;
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
