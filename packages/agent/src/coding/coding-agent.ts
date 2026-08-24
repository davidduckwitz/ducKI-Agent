import type { LLMProvider } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import type { ToolExecutor } from "@ducki/shared";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";
import {
  diagnosticsTool,
  filesystemTool,
  gitTool,
  shellTool,
  skillsTool,
  listIncompletePartSequences,
  clearIncompletePartSequences,
} from "@ducki/tools";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { Agent, TOOL_CALL_FORMAT_BLOCK } from "../agent.js";
import type { AgentEventEmitter, AgentRunOptions, AgentRunResult, AgentRunEventType, RunJournalEntry } from "../config/interfaces_types.js";
import { AGENT_HOOK_NAMES, type AgentHook } from "../hooks/index.js";
import { ToolApprovalPolicy, AllowedShellCommands } from "../tools/tool-approval-policy.js";
import { createScopedFilesystemTool } from "./scoped-filesystem-tool.js";
import { createScopedShellTool } from "./scoped-shell-tool.js";
import { createScopedDiagnosticsTool, resetDiagnosticsFor } from "./scoped-diagnostics-tool.js";
import { withAutoDiagnostics } from "./auto-diagnostics.js";
import { TodoList, createTodoTool, type TodoItem, type TodoStatus } from "./todo-tool.js";
import { createCheckpoint, diffCheckpoint, discardNoopCheckpoint } from "./checkpoints.js";
import { withPerEditCheckpoints } from "./checkpoint-on-write.js";
import { createExploreTool } from "./explore-tool.js";
import { createStatusTool, type StatusProvider } from "./status-tool.js";
import { Planner, type Plan, type PlanStep } from "../planner/planner.js";
import { formatPlanAsMarkdown, toPlanEventPayload } from "../planner/plan-tool.js";

const CODING_DIRECTIVE = `You are CodingAgent, a disciplined autonomous coding agent. You edit real code and must be careful and precise.

Discipline:
1. Plan the concrete files and steps before making any change.
2. Never edit a file you have not first read via the filesystem tool's "read" action.
3. Make minimal, targeted edits - do not restructure unrelated code. Prefer the filesystem tool's "edit" action (exact text replacement) over "write" for changes to existing files; only use "write" for new files or a genuine full-file replacement.
4. After every change, verify it: re-read the file or run a build/test command via the shell tool.
5. If a verification command fails, diagnose the ACTUAL error output before retrying - do not guess or repeat the same fix blindly.
6. Use the git tool to inspect diffs/status when useful, but never push or force operations unless explicitly asked.
7. Report concisely what changed and what you verified.

## Searching and reading efficiently - THIS DECIDES HOW FAST YOU FINISH
- SEARCH BEFORE YOU READ. Use filesystem action:"grep" (regex over file contents) or action:"glob"
  (find files by pattern) to locate the exact place first. Never open files one by one hoping to
  find something - a grep costs one call, ten speculative reads cost ten.
- READ IN PARALLEL. When you need several files, emit ALL of their read calls in ONE response.
  They have no dependencies on each other, so they execute as one batch instead of N round-trips.
- READ IN BIG WINDOWS, NOT SLICES. One read of a whole file beats five reads of 30 lines each.
  Only use offset/limit when a file is genuinely large and grep told you which region matters.
- FOR A BIG FILE, OUTLINE IT FIRST. filesystem action:"outline" lists its functions, classes and
  types with line numbers for a fraction of a full read - then read just the region you need.
- NEVER RE-READ A FILE YOU ALREADY READ unless you changed it since. Its content is still in this
  conversation. Re-reading costs the same tokens twice and tells you nothing new.
- Search results and reads skip node_modules, .git and build output by default. That is correct -
  do not set includeIgnored to work around a missing result; refine your pattern instead.

## Line numbers
The read action returns each line prefixed as "<n>: content". Those prefixes are display only -
they are NOT part of the file. When passing text to edit's oldString, copy only what comes AFTER
"<n>: ". Use the numbers to target the next read (offset) and to map compiler errors onto code.

## Delegate big searches
If locating something will take several greps and reads, hand it to the "explore" tool as ONE
specific question. It searches in its own context and returns only the answer, so the dozen file
dumps it took never enter this conversation. Use it for "where is X?" - not for a file you already
know, and never for making changes.

## Diagnostics beat builds
If a "diagnostics" tool is available, run it on the files you just changed instead of a full build.
It reports the same type/syntax errors in a fraction of the time. Use the full verification command
only once diagnostics are clean.

IMPORTANT - Multiline Content:
- When writing code with multiple lines, ALWAYS use actual line breaks (newlines), not \\n escape sequences.
- Each statement/line should be on its own line with proper indentation.
- This is CRITICAL for code to work correctly - improper formatting will break the code.`;

/** Filesystem actions that persist a change - gated by the phase-lock hook below during
 *  EXPLORE/PLAN, same set the truncation guard (callWouldPersistContent) cares about plus
 *  delete/move/copy, which are equally irreversible-by-accident during a read-only phase. */
const MUTATING_FILESYSTEM_ACTIONS = new Set(["write", "append", "edit", "edit_lines", "delete", "move", "copy"]);

/**
 * Matches a ">> PHASE: X" marker in a response (see CodingAgent.buildInitialPrompt). Not
 * anchored to line boundaries or exact spacing - weaker models reproduce the marker with
 * stray leading whitespace or trailing punctuation often enough that a strict match would
 * silently never fire for them, leaving the lock stuck on EXPLORE/PLAN forever (bounded by
 * phaseLockRefusals, but still worse than just recognizing the marker loosely).
 */
const PHASE_MARKER_RE = />>\s*PHASE:\s*(EXPLORE|PLAN|EDIT|VERIFY|REPORT)\b/gi;

/**
 * Matches a "<< X COMPLETE" completion marker. Same loose-matching rationale as
 * PHASE_MARKER_RE above: weaker models add stray whitespace/punctuation, and a strict match
 * would silently never fire, leaving the phase bar stuck on the last started phase forever.
 */
const PHASE_COMPLETE_MARKER_RE = /<<\s*(EXPLORE|PLAN|EDIT|VERIFY|REPORT)\s+COMPLETE\b/gi;

/**
 * Shell commands a sandboxed CodingAgent may run. Read-only inspection, the JS/TS toolchain
 * (including the package runners this monorepo actually uses), the common test runners, and the
 * two other ecosystems a project here is likely to be written in. Everything not listed - notably
 * `rm`, `curl`, `chmod`, `sudo` and arbitrary binaries - stays blocked.
 */
export const CODING_ALLOWED_SHELL_COMMANDS: readonly string[] = [
  // inspection
  "ls", "dir", "pwd", "cd", "cat", "type", "grep", "rg", "find", "head", "tail", "wc", "echo", "which", "where",
  // scaffolding that cannot destroy existing work
  "mkdir", "touch",
  // node / js toolchain
  "node", "npm", "npx", "pnpm", "yarn", "bun", "tsc", "tsx", "eslint", "prettier",
  // test runners
  "vitest", "jest", "mocha", "playwright", "pytest",
  // other ecosystems
  "python", "python3", "pip", "cargo", "rustc", "go", "make", "dotnet", "mvn", "gradle",
  // version control
  "git",
];

export interface CodingAgentOptions {
  name?: string;
  systemPrompt?: string;
  /** Per-attempt tool-call iteration budget, passed through to the underlying Agent. */
  maxIterations?: number;
  /** Macro plan -> verify -> iterate budget owned by CodingAgent itself. */
  maxAttempts?: number;
  /** When set, the filesystem tool defaults every call's basePath to this root. */
  sandboxRoot?: string;
  /** Additional tools beyond the curated filesystem/git/shell/skill_manage set. */
  extraTools?: ToolExecutor[];
  /**
   * Model used for the read-only `explore` sub-agent. Exploration is grep-and-read work with a
   * one-paragraph answer - it needs to follow instructions, not to reason deeply - so pointing
   * it at a small, fast model cuts the cost of the most call-heavy phase of a run by several
   * times without touching the quality of the actual edits. Falls back to the main provider.
   */
  explorerProvider?: LLMProvider;
  /**
   * Hard wall-clock budget for ONE explore call, in milliseconds. The explore sub-agent shares
   * the run loop's stale-read loop guardrail, but a slow-but-busy exploration could otherwise
   * block this coding run for its whole iteration budget - this caps that. Default:
   * DUCKI_EXPLORE_TIMEOUT_MS or 3 minutes.
   */
  exploreTimeoutMs?: number;
}

export interface CodingRunOptions {
  /**
   * Run inside an EXISTING conversation instead of opening a new one.
   *
   * Without this, every caller got a fresh "CodingAgent: <goal>" conversation - so a coding run
   * triggered from a chat the user is already sitting in produced a SECOND session in their
   * sidebar, holding the transcript they were waiting for, while the chat they were watching
   * stayed empty. A run started from a conversation belongs in that conversation.
   *
   * Omit it only for genuinely headless runs (cronjobs), which have no conversation to join.
   */
  conversationId?: number;
  /** Shell command run directly (no LLM round-trip) to deterministically check success. */
  verifyCommand?: string;
  /** Overrides the instance's default macro attempt budget for this run only. */
  maxAttempts?: number;
  /**
   * A plan the caller already has (e.g. user-reviewed in the Plan panel, or refined via the
   * Planner). When set, run() uses it as-is instead of calling the Planner itself - the point of
   * asking first is wasted if the answer gets thrown away and re-derived.
   */
  existingPlan?: Plan;
  /**
   * Wall-clock budget for the whole run, in milliseconds. Enforced as a soft deadline checked at
   * each attempt boundary (never aborts an in-flight LLM/tool call mid-way), so the run stops
   * cleanly once the budget is exhausted instead of retrying indefinitely. Omit/0 to disable.
   */
  timeoutMs?: number;
  /**
   * Fired once the run's conversation exists (right after the internal startConversation()
   * call, before the first attempt's LLM call). CodingAgent.run() doesn't return the
   * conversationId until the WHOLE run finishes - callers that need to reference/cancel this
   * specific run while it's still in flight (e.g. registering it so the existing Stop button
   * can find it) have no other way to learn the id early enough to matter.
   */
  onConversationStarted?: (conversationId: number) => void;
}

export interface CodingRunResult {
  success: boolean;
  summary: string;
  attempts: number;
  conversationId?: number;
  /** The command whose exit code decided `success`, or undefined if none could be
   *  determined - in that case `success` only means "the agent finished without
   *  throwing", not "the change was proven to work". */
  verifyCommand?: string;
  /** True only when a verification command actually ran and passed. */
  verified: boolean;
}

export interface CodingPhaseEvent {
  type: "phase_started" | "phase_completed" | "phase_failed";
  phase: "explore" | "plan" | "edit" | "verify" | "report";
  title: string;
  description?: string;
  result?: string;
  error?: string;
  timestamp: string;
  attempt: number;
}

/** Lines that actually carry a diagnosis. Ordered loosely by how specific they are. */
const VERIFY_ERROR_PATTERNS: RegExp[] = [
  /\berror\s+TS\d+/i,           // tsc
  /^\s*(?:✗|✘|×|FAIL|FAILED)\b/i, // vitest / jest / pytest summaries
  /\berror\b\s*:/i,             // eslint, rustc, generic
  /\bERR!/,                     // npm
  /^\s*(?:E|F)\s+\w+/,          // pytest short form
  /\bException\b|\bTraceback\b/,
  /\bSyntaxError\b|\bTypeError\b|\bReferenceError\b/,
  /\bCannot find\b|\bis not assignable\b|\bhas no exported member\b/,
  /\bexpected\b.*\breceived\b/i,
];

function isDiagnosticLine(line: string): boolean {
  return VERIFY_ERROR_PATTERNS.some((re) => re.test(line));
}

/**
 * Verification output is fed straight back into the next prompt, so every wasted character is
 * paid for twice: once in this attempt's context and again in the follow-up prompt.
 *
 * A head/tail cut (what this used to do) is the worst possible choice for build logs, because
 * the informative part of a failing build is neither the head (banner, config echo, progress
 * spinners) nor the tail (exit code, timing) - it is the diagnostic lines scattered in the
 * middle, which a 60/40 slice happily throws away while keeping 3.5KB of noise.
 *
 * So: pull out the diagnostic lines with one line of surrounding context each, and keep the
 * last few lines (the summary a runner prints at the end). Only when nothing looks like a
 * diagnostic does this fall back to the old head/tail behaviour, so an unrecognised toolchain
 * still gets *something* through rather than an empty report.
 */
export function condenseVerifyOutput(output: string, maxChars = 4000): string {
  if (output.length <= maxChars) return output;

  const lines = output.split("\n");
  const keep = new Set<number>();
  let diagnosticCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!isDiagnosticLine(lines[i]!)) continue;
    diagnosticCount++;
    // One line either side: tsc puts the offending source line under the error, and most
    // runners put the file path above it.
    for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) keep.add(j);
  }

  if (diagnosticCount === 0) {
    const head = output.slice(0, Math.floor(maxChars * 0.6));
    const tail = output.slice(-Math.floor(maxChars * 0.4));
    return `${head}\n[... ${output.length - maxChars} Zeichen gekuerzt ...]\n${tail}`;
  }

  // The final lines are almost always the runner's own summary ("3 failed, 12 passed").
  for (let i = Math.max(0, lines.length - 5); i < lines.length; i++) keep.add(i);

  const ordered = [...keep].sort((a, b) => a - b);
  const out: string[] = [];
  let used = 0;
  let previous = -1;
  let omitted = 0;

  for (const index of ordered) {
    if (index !== previous + 1 && previous !== -1) out.push("  …");
    const line = lines[index]!;
    if (used + line.length > maxChars) {
      omitted = ordered.length - out.length;
      break;
    }
    out.push(line);
    used += line.length + 1;
    previous = index;
  }

  const header = `[${diagnosticCount} diagnostic line(s) extracted from ${lines.length} lines of output]`;
  const footer = omitted > 0 ? `\n[… ${omitted} further diagnostic line(s) omitted - fix these first]` : "";
  return `${header}\n${out.join("\n")}${footer}`;
}

/**
 * Composes an Agent with a curated coding tool set and directive system prompt,
 * then orchestrates it through a plan -> verify -> iterate macro loop across
 * several agent.run() calls on the same conversation thread. Composition (not
 * subclassing) because Agent's tool-call loop internals are private and don't
 * need to change - only how many times, and with what follow-up, it's called.
 */
export class CodingAgent {
  private readonly agent: Agent;
  private readonly eventEmitter: AgentEventEmitter | undefined;
  private readonly defaultMaxAttempts: number;
  private readonly sandboxRoot: string | undefined;
  private filesRead = new Set<string>(); // Track files read during this run
  /** How often read-before-edit refused a given file this run (see the hook for why it is bounded). */
  private readBeforeEditRefusals = new Map<string, number>();
  private readonly todos: TodoList;
  private readonly logger: Logger;
  private readonly planner: Planner;
  /**
   * The phase the model last declared via its ">> PHASE: X" marker (see buildInitialPrompt),
   * kept as REAL state instead of only being read back after the whole attempt finished (the
   * old extractAndEmitPhaseEvents, which runs once the response is already complete - too late
   * to gate anything). Updated live via AgentRunOptions.onModelResponse, so the phase-lock hook
   * below sees the CURRENT phase for every tool call, including ones in the same response that
   * declared the transition.
   *
   * "unstarted" is the sentinel before any marker has been seen this run/attempt - it does NOT
   * lock writes. Only "explore"/"plan" do. This matters for anything that drives the discipline
   * hooks without going through the actual phase-prompt flow (unit tests calling the hook
   * directly, runOnExistingConversation, a caller-supplied existingPlan skipping straight to
   * edits) - none of those ever call updatePhaseFromResponse, so without this sentinel they
   * would be locked out of every write by a default they never opted into.
   */
  private currentPhase: "unstarted" | "explore" | "plan" | "edit" | "verify" | "report" = "unstarted";
  /** How often the phase lock refused a write this run - bounded for the same reason as
   *  readBeforeEditRefusals (see that hook): an unbounded refusal on a model that never emits
   *  the phase marker would deadlock the run instead of ever letting it edit anything. */
  private phaseLockRefusals = 0;
  /**
   * The most advanced phase-event already emitted per phase this run, used to deduplicate the
   * live emission path (updatePhaseFromResponse) against the end-of-attempt backfill
   * (extractAndEmitPhaseEvents). Ranks: started=1, completed=2. A lower rank is never emitted
   * over a higher one, so the backfill cannot regress a phase the live path already completed.
   * Also tracks whether the emitted payload already carried the `result`/`error` text so a
   * duplicate completed event with richer info can merge that text in (see emitPhase).
   */
  private livePhaseEmitted = new Map<string, { rank: number; hasResult: boolean; hasError: boolean }>();
  /**
   * Files whose last edit left live (from auto-diagnostics) diagnostic errors, mapped to the
   * error count and a sample of what the errors look like. Updated by the afterTool hook below
   * whenever a filesystem write/edit/append completes; cleared for a file when it is re-edited
   * and comes back clean (or edited again at all, since a second edit replaces the first).
   */
  private pendingDiagnosticErrors = new Map<string, { count: number; errors: string[] }>();
  /** Bounded like phaseLockRefusals/readBeforeEditRefusals: one warning per file pair, then the
   *  guard gets out of the way rather than deadlocking a run that insists on editing anyway. */
  private diagnosticGuardRefusals = 0;
  /** Read by withPerEditCheckpoints' label closure - kept as instance state because tools are
   *  registered ONCE in the constructor, before any attempt number exists yet. */
  private currentAttempt = 0;
  /** Kept for CodingAgent's OWN event persistence (see emit()/emitPlanEvent()) - separate from
   *  the `db` handed to the internal `Agent`, which persists ITS OWN events but knows nothing
   *  about CodingAgent's plan/phase/decision events (emitEvent() only ever broadcast them over
   *  the eventEmitter, with no DB row - see emit()'s doc comment for why that mattered). */
  private readonly db: DatabaseService;
  /** conversationId of the run currently in progress - set at the top of run(), read by
   *  emit()/emitPlanEvent() so they don't need conversationId threaded through every call site
   *  (mirrors currentAttempt/currentPhase above). Undefined before the first run() call. */
  private currentConversationId: number | undefined;
  /** Serializes this instance's own event-persistence writes so row order in the DB matches
   *  emission order, without making any emit() call itself await the write - same pattern as
   *  Agent.run()'s internal eventPersistQueue (agent.ts), applied here because CodingAgent now
   *  persists its OWN events (plan/decision/phase) independently of that one. */
  private eventPersistQueue: Promise<void> = Promise.resolve();
  /** The plan currently backing this run - mutable (unlike a `const plan` in run()) so
   *  syncPlanFromTodos can update it in place when the model rewrites the checklist. Undefined
   *  before run() computes/rehydrates a plan. */
  private currentPlan: Plan | undefined;
  /** True while CodingAgent itself is seeding/reseeding the checklist (initial seed from the
   *  plan, or rehydration on resume) rather than the MODEL deciding to rewrite it. Those internal
   *  replace() calls would otherwise trigger syncPlanFromTodos right after the plan they were
   *  seeded FROM was already emitted, producing an immediate, pointless duplicate "plan" event. */
  private suppressPlanSync = false;

  constructor(
    provider: LLMProvider,
    db: DatabaseService,
    eventEmitter?: AgentEventEmitter,
    options: CodingAgentOptions = {}
  ) {
    this.defaultMaxAttempts = Math.max(1, options.maxAttempts ?? 4);
    this.sandboxRoot = options.sandboxRoot;
    this.eventEmitter = eventEmitter;
    this.db = db;
    this.logger = getRootLogger().child(`CodingAgent:${options.name ?? "CodingAgent"}`);
    this.planner = new Planner(provider, this.logger);

    // Every checklist change is pushed straight to the UI, so what the user watches is the same
    // state the agent is steering by - not a second, prose-derived approximation of it.
    this.todos = new TodoList(
      (items) => {
        this.emit("decision", "Checkliste aktualisiert", {
          todo_items: items,
          open: items.filter((item) => item.status === "pending" || item.status === "in_progress").length,
        });
      },
      // Structural change (todo:write) - mirror it back into the Plan the UI's Plan tab
      // actually renders, see syncPlanFromTodos for why this exists.
      (items) => this.syncPlanFromTodos(items)
    );

    // The text-based [TOOL:...] format block is only relevant when the provider falls back to
    // parsing tool calls out of plain text. A provider with native tool_calls support (the
    // agent.ts run loop already prefers that path, see nativeToolsEnabled) never needs this
    // block - appending it anyway just adds ~1.5-2KB of now-irrelevant instructions to every
    // single LLM call of the run, and risks the model mixing both formats.
    const needsTextToolFormat = !(provider.supportsNativeTools?.() ?? false);
    const basePrompt =
      options.systemPrompt ??
      (needsTextToolFormat ? `${CODING_DIRECTIVE}\n\n${TOOL_CALL_FORMAT_BLOCK}` : CODING_DIRECTIVE);

    // Phase 1 & 2: Register discipline hooks for CodingAgent
    const disciplineHooks: AgentHook[] = [
      {
        name: "coding-discipline-read-before-edit",
        priority: 60,
        handler: async (context: any) => {
          // beforeTool hook: enforce "read before edit" discipline
          const toolName = context.toolName as string;
          const input = context.input as Record<string, unknown>;

          if (toolName === "filesystem") {
            const action = String(input.action ?? "").toLowerCase();
            const rawPath = String(input.path ?? "");

            if (rawPath) {
              // Paths are normalised before comparison: "src/a.ts", "./src/a.ts" and the
              // absolute form all denote the same file, but as raw strings they did not,
              // so the rule could be sidestepped (or fire spuriously) by spelling alone.
              const key = this.fileKey(rawPath);

              // `write` is included, unlike before: overwriting an existing file blind is
              // exactly the destructive case this rule exists to prevent. A write to a path
              // that does not exist yet is a genuine file creation and stays allowed.
              if (["edit", "write", "append", "delete"].includes(action)) {
                const targetExists = existsSync(this.absoluteFilePath(rawPath));
                if (targetExists && !this.filesRead.has(key)) {
                  // Refuse ONCE per file, then get out of the way.
                  //
                  // An unbounded refusal is a deadlock: a model that does not act on the
                  // instruction retries the same call, and each refusal counts as a failed
                  // tool call, so the run dies on the consecutive-failure guardrail without a
                  // single edit having been attempted. The rule exists to make the agent look
                  // before it overwrites - one refusal delivers that message. If it insists
                  // anyway, the per-attempt checkpoint is the real safety net, and it is a far
                  // better one than a rule that can only kill the run.
                  const refusals = (this.readBeforeEditRefusals.get(key) ?? 0) + 1;
                  this.readBeforeEditRefusals.set(key, refusals);
                  if (refusals === 1) {
                    return {
                      proceed: false,
                      reason:
                        `Discipline violation: '${rawPath}' already exists and you have not read it in this run. ` +
                        `Use action:"read" on it first, then make a targeted edit instead of overwriting it blind. ` +
                        `(If you genuinely intend to replace the whole file, repeat this call and it will go through.)`,
                    };
                  }
                  this.emit("decision", `Read-before-edit uebergangen fuer '${rawPath}'.`, {
                    path: rawPath,
                    refusals,
                  });
                }
              }

              // Track afterwards, never before the check above. After a read the agent knows
              // the content; after a write it authored the content, so a follow-up edit on
              // the same file needs no separate read.
              if (action === "read" || action === "write") {
                this.filesRead.add(key);
              }
            }
          }

          return { proceed: true };
        },
      },
      {
        name: "coding-discipline-phase-lock",
        priority: 55,
        handler: async (context: any) => {
          const toolName = context.toolName as string;
          const input = context.input as Record<string, unknown>;
          if (toolName !== "filesystem") return { proceed: true };

          const action = String(input.action ?? "").toLowerCase();
          if (!MUTATING_FILESYSTEM_ACTIONS.has(action)) return { proceed: true };
          if (this.currentPhase !== "explore" && this.currentPhase !== "plan") return { proceed: true };

          // Bounded exactly like read-before-edit above: one refusal states the rule, then get
          // out of the way rather than risk deadlocking a run whose model never emits the
          // ">> PHASE: EDIT" marker at all.
          this.phaseLockRefusals++;
          if (this.phaseLockRefusals === 1) {
            return {
              proceed: false,
              reason:
                `Discipline violation: you are still in the ${this.currentPhase.toUpperCase()} phase (no ` +
                `">> PHASE: EDIT" marker seen yet), which is read/plan-only - no file changes yet. ` +
                `State "<< ${this.currentPhase.toUpperCase()} COMPLETE" and ">> PHASE: EDIT" first, then repeat this call.`,
            };
          }
          this.emit("decision", `Phasensperre uebergangen (Phase: ${this.currentPhase}).`, {
            phase: this.currentPhase,
            refusals: this.phaseLockRefusals,
          });
          // The model is now demonstrably editing, whatever text marker it did or didn't
          // produce - a mutating filesystem call is a stronger, structural signal than the
          // freetext ">> PHASE: EDIT" marker updatePhaseFromResponse relies on. Without this,
          // currentPhase stays stuck at "explore"/"plan" for the REST of the run once a model
          // that never emits the marker gets past this one-time bypass: every later write keeps
          // logging a misleading "Phasensperre uebergangen (Phase: explore)", and any prompt
          // text that references currentPhase (e.g. buildFollowUpPrompt) would describe a phase
          // the run is clearly long past.
          this.currentPhase = "edit";
          return { proceed: true };
        },
      },
    ];

    // Phase 2: Create approval policy for safe coding (restrict destructive operations).
    // The list is a *capability* whitelist, not a taste list: everything here either inspects
    // the project or runs its own toolchain. It deliberately includes the runners the agent is
    // actually judged by - detectDefaultVerifyCommand() emits `npx tsc --noEmit`, and this repo
    // is a pnpm workspace, so blocking `npx`/`pnpm`/`tsc` meant the agent could not run the very
    // command whose exit code decides whether its run counts as successful.
    const codingApprovalPolicy = new ToolApprovalPolicy([
      // Only allow safe shell commands: no rm -rf, git force-push, arbitrary binaries, etc.
      new AllowedShellCommands(
        [...CODING_ALLOWED_SHELL_COMMANDS],
        "Only safe shell commands allowed in coding mode"
      ),
    ]);
    disciplineHooks.push({
      name: "coding-discipline-shell-approval",
      priority: 50,
      handler: async (context: any) => {
        const toolName = context.toolName as string;
        const input = (context.input as Record<string, unknown>) ?? {};
        const check = await codingApprovalPolicy.check(toolName, input);
        if (!check.approved) {
          return { proceed: false, reason: check.reason ?? "Blocked by coding approval policy" };
        }
        return { proceed: true };
      },
    });

    // Live diagnostics guard: warn when the model edits a new file while a previous file still
    // has diagnostic errors from the auto-diagnostics layer (withAutoDiagnostics). The guard
    // runs BEFORE the next edit, so unlike cross-turn feedback (which needs another LLM
    // round-trip), this fires in the tool-execution path that would be the NEXT turn — the model
    // already SAW the diagnostic errors in the previous turn's tool result, and is now choosing
    // to edit something else instead. Bounded like the other guards: one warning, then out.
    disciplineHooks.push({
      name: "coding-diagnostics-cross-file-guard",
      priority: 40,
      handler: async (context: any) => {
        const toolName = context.toolName as string;
        if (toolName !== "filesystem") return { proceed: true };
        const input = context.input as Record<string, unknown>;
        const action = String(input.action ?? "").toLowerCase();
        if (!MUTATING_FILESYSTEM_ACTIONS.has(action)) return { proceed: true };

        const rawPath = String(input.path ?? "");
        if (!rawPath) return { proceed: true };

        // Gather every path this action touches. Move/copy have a destination field too —
        // if the destination is in pendingDiagnosticErrors (e.g. a previous edit left errors
        // there), this action replaces/overwrites it, so clear the pending state.
        const touchedKeys: string[] = [this.fileKey(rawPath)];
        if (action === "move" || action === "copy") {
          const dest = typeof input["destination"] === "string" ? input["destination"] : "";
          if (dest) touchedKeys.push(this.fileKey(dest));
        }

        // Editing the same file the diagnostic error is for: that IS the fix — clear it.
        let clearsExisting = false;
        for (const key of touchedKeys) {
          if (this.pendingDiagnosticErrors.has(key)) {
            this.pendingDiagnosticErrors.delete(key);
            clearsExisting = true;
          }
        }
        if (clearsExisting) return { proceed: true };

        // Editing a DIFFERENT file while another file still has pending errors — warn once.
        if (this.pendingDiagnosticErrors.size > 0 && this.diagnosticGuardRefusals < 1) {
          this.diagnosticGuardRefusals++;
          const badFiles = [...this.pendingDiagnosticErrors.entries()]
            .map(([path, info]) => `- ${path} (${info.count} error(s): ${info.errors.slice(0, 3).join("; ")})`)
            .join("\n");
          this.emit("decision", `Erneuter Edit auf anderer Datei trotz pending diagnostic errors.`, {
            currentFile: rawPath,
            filesWithErrors: [...this.pendingDiagnosticErrors.keys()],
          });
          return {
            proceed: false,
            reason:
              `Live diagnostics show these file(s) still have errors from your last edit, but you are now ` +
              `trying to edit '${rawPath}' instead of fixing them:\n${badFiles}\n\n` +
              `Fix the errors in those files first — do not move to another file until the previous one ` +
              `is clean. (If you genuinely need to edit this file first, repeat this call and it will go through.)`,
          };
        }
        return { proceed: true };
      },
    });

    // After every tool call, track diagnostic errors from the auto-diagnostics layer
    // (withAutoDiagnostics) so the cross-file guard above knows which files need fixing.
    const afterToolHooks: AgentHook[] = [
      {
        name: "coding-live-diagnostics-tracker",
        priority: 50,
        handler: async (context: any) => {
          const toolName = context.toolName as string;
          if (toolName !== "filesystem") return { proceed: true };
          const result = context.result as { success: boolean; data?: Record<string, unknown> } | undefined;
          if (!result?.success) return { proceed: true };

          const data = result.data as Record<string, unknown> | undefined;
          const diag = data?.["diagnostics"] as {
            ok: boolean;
            errorCount: number;
            errors?: string[];
            checkedFiles?: string[];
          } | undefined;
          if (!diag) return { proceed: true };

          // The diagnostics layer now reports which files it checked (checkedFiles). For
          // write/edit/append it is one file; for move/copy it is both source and destination.
          // Clear or set the pending state for EVERY file that was checked, not only the one
          // in input.path — otherwise a copy's destination file silently stays in the pending
          // set even after a clean check.
          const checkedFiles: string[] = Array.isArray(diag.checkedFiles) && diag.checkedFiles.length > 0
            ? diag.checkedFiles
            : (() => {
                // Fallback for diagnostics results that predate this change: use input.path.
                const input = context.input as Record<string, unknown>;
                const p = String(input["path"] ?? "");
                return p ? [p] : [];
              })();

          for (const file of checkedFiles) {
            const key = this.fileKey(file);
            if (diag.ok || diag.errorCount === 0) {
              this.pendingDiagnosticErrors.delete(key);
            } else {
              this.pendingDiagnosticErrors.set(key, {
                count: diag.errorCount,
                errors: Array.isArray(diag.errors) ? diag.errors.slice(0, 5) : [String(diag.errorCount)],
              });
            }
          }
          return { proceed: true };
        },
      },
    ];

    this.agent = new Agent(provider, db, eventEmitter, {
      name: options.name ?? "CodingAgent",
      systemPrompt: basePrompt,
      // 100 per attempt x 4 attempts allowed 400 LLM calls for a single goal. A coding turn
      // that has not converged in 40 tool-call iterations is not going to converge in 60 - it
      // is looping. The macro attempt loop (with its verify feedback) is the productive retry
      // path, not a longer inner loop.
      maxIterations: options.maxIterations ?? 40,
      hooks: disciplineHooks,
      afterToolHooks,
      // Code responses are long and slow to re-evaluate; the reflection/verify
      // passes repeatedly hit their timeout with a local model. Skip them here.
      disableQualityPasses: true,
      // CodingAgent already has its OWN structured plan (this.planner.createPlan() above,
      // seeded into this.todos before the attempt loop starts). Agent.run()'s enablePlanning
      // defaults to true and would otherwise call the Planner AGAIN, independently, on every
      // single attempt (this.agent.run() call) - a second, unrelated plan derived from whatever
      // that attempt's prompt happens to be (the ORIGINAL goal on attempt 1, but a follow-up
      // "fix this error" prompt on later attempts), never wired into CodingAgent's checklist and
      // never used for anything but a log line. That wasted a full extra Planner LLM round-trip
      // PER ATTEMPT and produced the confusing "Plan erstellt mit N Schritten" events with
      // shifting, seemingly random step counts that don't correspond to the actual checklist.
      enablePlanning: false,
      // Every attempt is this.agent.run() again on the SAME Agent instance for the SAME
      // overall goal - the relevant skill (usually just "coding-system" plus whatever
      // auto-selects) does not need re-scoring and re-loading from disk on every attempt.
      // run() itself resets the cache so a genuinely new goal still gets fresh selection.
      stickySkillSelection: true,
    });

    const baseFsTool = options.sandboxRoot ? createScopedFilesystemTool(options.sandboxRoot) : filesystemTool;
    const diagnosedFsTool = withAutoDiagnostics(baseFsTool, options.sandboxRoot);
    // Per-edit checkpoints (see the wrapper's own doc comment) - a no-op when there is no
    // sandboxRoot, since the shadow-git checkpoint mechanism only exists for sandboxed runs.
    const fsTool = withPerEditCheckpoints(diagnosedFsTool, options.sandboxRoot, () => `Attempt ${this.currentAttempt}`);
    const shTool = options.sandboxRoot ? createScopedShellTool(options.sandboxRoot) : shellTool;
    const dxTool = options.sandboxRoot ? createScopedDiagnosticsTool(options.sandboxRoot) : diagnosticsTool;
    const exploreTool = createExploreTool(options.explorerProvider ?? provider, db, {
      ...(options.sandboxRoot ? { sandboxRoot: options.sandboxRoot } : {}),
      timeoutMs: options.exploreTimeoutMs ?? parseInt(process.env["DUCKI_EXPLORE_TIMEOUT_MS"] ?? "180000", 10),
    });

    // Run-scoped status snapshot: phase, checklist, open diagnostics, and checkpoint diff -
    // the one ground-truth source the agent can query when conversation context is trimmed and
    // earlier tool results ("I created file X") are no longer visible. Closure through proxy so
    // the tool always reads live state, not a snapshot-at-construction-time.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const statusTool = createStatusTool({
      sandboxRoot: self.sandboxRoot,
      get currentAttempt(): number { return self.currentAttempt; },
      get currentPhase(): string { return self.currentPhase; },
      checklistSnapshot: () => self.todos.snapshot(),
      pendingDiagnosticErrorsSnapshot: () =>
        [...self.pendingDiagnosticErrors.entries()].map(([file, info]) => ({
          file,
          count: info.count,
          errors: info.errors,
        })),
    });

    for (const tool of [fsTool, shTool, dxTool, gitTool, skillsTool, createTodoTool(this.todos), exploreTool, statusTool, ...(options.extraTools ?? [])]) {
      this.agent.executor.registerTool(tool);
    }
  }

  /**
   * Scans a model response for phase markers and (a) updates currentPhase - which the phase-lock
   * hook (see the constructor) reads for every tool call in this same response - and (b) emits
   * live phase events so the UI's phase bar advances in real time instead of only when the whole
   * attempt finishes.
   *
   * Called via AgentRunOptions.onModelResponse, i.e. before this response's own tool calls are
   * validated - a response that says ">> PHASE: EDIT" and then immediately writes a file in the
   * same turn is exactly the intended flow, not a race.
   *
   * Handles BOTH start markers (">> PHASE: X") and completion markers ("<< X COMPLETE"), and
   * processes them in source order so a response that contains two full phases still emits both
   * transitions in the right sequence. currentPhase becomes the LAST started phase, matching the
   * previous behaviour (the phase-lock only ever needed the latest declared phase).
   */
  private updatePhaseFromResponse(response: string): void {
    const transitions: Array<{ index: number; phase: string; event: "phase_started" | "phase_completed" }> = [];

    for (const match of response.matchAll(PHASE_MARKER_RE)) {
      const phase = match[1]?.toLowerCase();
      if (!phase || match.index === undefined) continue;
      transitions.push({ index: match.index, phase, event: "phase_started" });
    }
    for (const match of response.matchAll(PHASE_COMPLETE_MARKER_RE)) {
      const phase = match[1]?.toLowerCase();
      if (!phase || match.index === undefined) continue;
      transitions.push({ index: match.index, phase, event: "phase_completed" });
    }
    transitions.sort((a, b) => a.index - b.index);

    // The phase-lock reads the LAST started phase (unchanged from before).
    let lastStarted: string | undefined;
    for (const transition of transitions) {
      if (transition.event === "phase_started") lastStarted = transition.phase;
    }
    if (lastStarted && ["explore", "plan", "edit", "verify", "report"].includes(lastStarted)) {
      this.currentPhase = lastStarted as "explore" | "plan" | "edit" | "verify" | "report";
    }

    // Emit live phase events (deduplicated in emitPhase against prior/backfill emissions).
    for (const transition of transitions) {
      this.emitPhase({
        type: transition.event,
        phase: transition.phase as CodingPhaseEvent["phase"],
        title: transition.phase.charAt(0).toUpperCase() + transition.phase.slice(1),
        timestamp: new Date().toISOString(),
        attempt: this.currentAttempt,
      });
    }
  }

  /** Absolute location of a model-supplied path, resolved against the sandbox when there is one. */
  private absoluteFilePath(rawPath: string): string {
    const trimmed = rawPath.trim();
    if (isAbsolute(trimmed)) return resolve(trimmed);
    return this.sandboxRoot ? resolve(this.sandboxRoot, trimmed) : resolve(trimmed);
  }

  /** Identity of a file for read-tracking: same file, same key, however it was spelled. */
  private fileKey(rawPath: string): string {
    const absolute = this.absoluteFilePath(rawPath).replace(/\\/g, "/");
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  }

  private autoSelectCodingSkill(goal: string): string | undefined {
    const skillKeywords = {
      "test-driven-development": ["test", "tdd", "unit test", "jest", "vitest", "spec"],
      "code-review": ["review", "quality", "style", "lint", "format"],
      "debugging": ["debug", "error", "bug", "fix", "crash"],
      "planning": ["plan", "architecture", "design", "structure"],
    };

    const goalLower = goal.toLowerCase();
    for (const [skill, keywords] of Object.entries(skillKeywords)) {
      if (keywords.some(kw => goalLower.includes(kw))) {
        return skill;
      }
    }

    return undefined;
  }

  /**
   * package.json's "scripts" map, or undefined when there is no package.json (i.e. this is not
   * an npm project at all) or it fails to parse. The single place that reads it, so every
   * npm-command decision below is gated on the same "does this project actually have this
   * script" check instead of assuming npm just because a skill or heuristic suggests one.
   */
  private readPackageJsonScripts(): Record<string, string> | undefined {
    if (!this.sandboxRoot) return undefined;
    const packageJsonPath = join(this.sandboxRoot, "package.json");
    if (!existsSync(packageJsonPath)) return undefined;
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
      return pkg.scripts;
    } catch {
      return undefined; // malformed package.json - nothing detectable
    }
  }

  /**
   * Best-effort default so "no verifyCommand" doesn't silently mean "no check
   * at all" - falls back to a project-detected typecheck/build, or undefined
   * if nothing detectable exists (never fabricates a command that would fail
   * for unrelated reasons, e.g. an npm command on a project that isn't npm at all).
   */
  private detectDefaultVerifyCommand(): string | undefined {
    if (!this.sandboxRoot) return undefined;
    if (existsSync(join(this.sandboxRoot, "tsconfig.json"))) {
      return "npx tsc --noEmit";
    }
    if (this.readPackageJsonScripts()?.["build"]) return "npm run build";
    return undefined;
  }

  get executor() {
    return this.agent.executor;
  }

  async loadConversation(conversationId: number): Promise<void> {
    return this.agent.loadConversation(conversationId);
  }

  /** Stops the current attempt's underlying Agent (aborts the in-flight LLM call and prevents
   *  further attempts) - delegates to Agent.stop(), which already does the right thing. */
  stop(): void {
    this.agent.stop();
  }

  async runOnExistingConversation(
    prompt: string,
    options: AgentRunOptions = {}
  ): Promise<AgentRunResult> {
    return this.agent.run(prompt, options);
  }

  async run(goal: string, opts: CodingRunOptions = {}): Promise<CodingRunResult> {
    // Per-run state. Without this reset a second run() on the same instance inherits the first
    // run's read-set, so the read-before-edit rule silently stops applying to files the agent
    // touched in an earlier, unrelated goal.
    this.filesRead = new Set<string>();
    this.readBeforeEditRefusals = new Map<string, number>();
    this.currentPhase = "unstarted";
    this.phaseLockRefusals = 0;
    this.livePhaseEmitted = new Map<string, { rank: number; hasResult: boolean; hasError: boolean }>();
    this.pendingDiagnosticErrors = new Map<string, { count: number; errors: string[] }>();
    this.diagnosticGuardRefusals = 0;
    this.currentPlan = undefined;
    this.suppressPlanSync = false;
    this.todos.reset();
    // A new goal on this instance must re-select skills, not reuse the previous goal's - see
    // stickySkillSelection in the Agent constructor above.
    this.agent.resetSkillSelectionCache();
    // The sandbox may have changed between runs (files added or removed outside the agent), and
    // a stale warm compiler would report diagnostics for a file set that no longer exists.
    resetDiagnosticsFor(this.sandboxRoot);
    // Fresh session: a part sequence left incomplete by an earlier crashed/stopped run must
    // not be reported as if THIS run started it (see finalizeRun's end-of-run warning).
    clearIncompletePartSequences(this.sandboxFilter());

    const maxAttempts = Math.max(1, opts.maxAttempts ?? this.defaultMaxAttempts);

    // Join the caller's conversation when there is one; only open a new one otherwise.
    // The callback fires either way - callers use it to register the run so the Stop button
    // can find it, and that is just as necessary for a joined conversation as for a new one.
    const reuseId = opts.conversationId;
    const isResuming = typeof reuseId === "number" && Number.isFinite(reuseId) && reuseId > 0;
    // origin:"coding_agent" only on a genuinely FRESH conversation - resuming an existing one
    // (isResuming) must never retag it, since that conversation may well be a normal chat the
    // user started (e.g. Plan execution reusing the chat it was planned in - see plans.ts).
    // Tags every conversation CodingAgent.run() opens for itself so the chat overview can
    // exclude it by default (see the conversations.origin schema comment) - it's already
    // visible in the Coding area/plugin wizard, whichever caller created it.
    const conversationId = isResuming
      ? (await this.agent.loadConversation(reuseId), reuseId)
      : await this.agent.startConversation({ name: `CodingAgent: ${goal.slice(0, 60)}`, origin: "coding_agent" });
    opts.onConversationStarted?.(conversationId);
    // Everything emit()/emitPlanEvent()/emitPhase() persist from here on targets this run's
    // conversation - see persistEvent().
    this.currentConversationId = conversationId;

    // End-of-run guard: if a parted write (totalParts/partNumber) was started during this run
    // but not all parts arrived, the run must NOT end silently - the file(s) on disk are
    // incomplete, and that is exactly the "looks finished but parts are missing" failure the
    // part protocol exists to surface. Instead of merely warning, a bounded targeted follow-up
    // attempt writes exactly the missing parts (see healIncompleteSequences); the warning is
    // the fallback when healing does not finish the job. Every return path below goes through
    // this wrapper.
    const finalize = async (result: CodingRunResult): Promise<CodingRunResult> => {
      const incomplete = listIncompletePartSequences(this.sandboxFilter());
      if (incomplete.length === 0) return result;

      // After an explicit Stop, auto-starting more LLM calls would be surprising - warn only.
      const stopped = (this.agent as unknown as { stopRequested: boolean }).stopRequested === true;
      const healDetail = stopped ? null : await this.healIncompleteSequences(incomplete, conversationId);

      const stillIncomplete = listIncompletePartSequences(this.sandboxFilter());
      if (stillIncomplete.length === 0) {
        this.emit("decision", "Self-Healing: fehlende Datei-Teile nachgeschrieben.", {
          part_healed: true,
          files: incomplete,
        });
        return {
          ...result,
          summary:
            `${result.summary}\n\n[Self-Healing: die fehlenden Datei-Teile wurden automatisch ` +
            `nachgeschrieben.${healDetail ? ` ${healDetail}` : ""}]`,
        };
      }

      const lines = stillIncomplete.map(
        (g) => `- ${g.path}: ${g.received}/${g.totalParts} Teile geschrieben, Teil ${g.next} fehlt`
      );
      const head = stopped
        ? "Unvollstaendige Datei-Schreibsequenz(en) - der Lauf endete, bevor alle Teile geschrieben wurden:"
        : "Unvollstaendige Datei-Schreibsequenz(en) - auch nach dem automatischen Folge-Versuch sind die Datei(en) nicht vollstaendig:";
      const warning =
        head +
        `\n` +
        lines.join("\n") +
        `\nDie Datei(en) sind unvollstaendig. Schreibe die fehlenden Teile ` +
        `(action:append partNumber:${stillIncomplete[0]!.next} totalParts:${stillIncomplete[0]!.totalParts}) nach ` +
        `oder schreibe die Datei(en) neu.${healDetail ? `\n${healDetail}` : ""}`;
      this.emit("decision", `Warnung: ${stillIncomplete.length} unvollstaendige Datei-Schreibsequenz(en)`, {
        part_warning: true,
        files: stillIncomplete,
      });
      return { ...result, summary: `${result.summary}\n\nWARNUNG: ${warning}` };
    };

    const detectedSkill = this.autoSelectCodingSkill(goal);
    let verifyCommand = opts.verifyCommand;

    if (!verifyCommand && detectedSkill === "code-review") {
      // "npm test" is deliberately never auto-selected as a verifyCommand - a project's test
      // suite can be slow, flaky, or require setup the sandbox doesn't have, so forcing it as
      // the pass/fail gate for every TDD-flavored goal caused more false failures than it
      // caught. Lint stays: cheap, fast, no state to set up.
      const scripts = this.readPackageJsonScripts();
      if (scripts?.["lint"]) verifyCommand = "npm run lint";
    }

    if (!verifyCommand) {
      verifyCommand = this.detectDefaultVerifyCommand();
    }

    // When resuming an existing conversation with a new goal (the user typed follow-up
    // instructions in the coding chat), the persisted plan from a previous run describes a
    // DIFFERENT task — reusing it would tell the agent to "create a landing page" when the
    // user just asked "add a contact form." Only rehydrate when there is genuinely NO new
    // goal (recover from crash/stop with the SAME conversation). A new goal always gets a
    // fresh plan; the old plan + checklist are still loaded below for hydration, but only
    // the checklist status (what was already done) carries over — not the plan steps.
    const persisted = isResuming && !opts.existingPlan ? await this.loadPersistedState(conversationId) : undefined;

    // Real planning subagent: a structured, detailed plan from the Planner instead of letting
    // the model invent one in free text during the PLAN phase (see buildInitialPrompt). A
    // caller-supplied plan (already reviewed/refined by the user, e.g. via the Plan panel) is
    // used as-is - re-deriving it here would throw away exactly the decision the caller made.
    // When resuming, we still call the Planner for the NEW goal — the old plan was for a
    // different task (or the same task's previous attempt, now stale).
    const toolNames = this.agent.executor.listTools().map((tool) => tool.name);
    const plan = opts.existingPlan ?? (await this.planner.createPlan(goal, toolNames));
    this.currentPlan = plan;
    this.emitPlanEvent(plan);
    // Pre-seeds the checklist with the planner's steps so the UI shows real progress from the
    // very first tool call, instead of an empty list until the model gets around to calling
    // todo:write itself. Title-matched merge (see TodoList.replace) keeps these ids stable if
    // the model later calls todo:write again to adjust the plan post-exploration.
    //
    // A rehydrated checklist (real per-step status, not just titles) is only trusted when the
    // PLAN it belongs to was also rehydrated - applying old step statuses to a plan that came
    // from opts.existingPlan or a fresh Planner call would attach stale progress to steps that
    // may not even correspond to the same work.
    //
    // suppressPlanSync: this seed reflects the plan we JUST emitted above, so mirroring it back
    // via syncPlanFromTodos would only reconstruct an equivalent plan and fire a redundant,
    // pointless second "plan" event/DB row - only a MODEL-initiated todo:write later in the run
    // should trigger that.
    this.suppressPlanSync = true;
    try {
      // Always seed from the fresh plan. The old checklist (persisted.todoItems) was for a
      // different goal — carrying those statuses onto new, unrelated steps would show a fake
      // "already done" checklist for what is actually a brand-new task.
      this.todos.replace(plan.steps.map((step) => ({ title: step.title })));
    } finally {
      this.suppressPlanSync = false;
    }

    const deadline = opts.timeoutMs && opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : undefined;

    let lastSummary = "";
    // Carried across attempts (not reset per attempt) so a retry after a failed verify still
    // remembers what earlier attempts already did - each this.agent.run() call would otherwise
    // start its own runLoop's journal empty, discarding it the moment this attempt's response
    // came back, even though attempts 1..N-1 share the same conversation and sandbox.
    let journal: RunJournalEntry[] = [];
    // Detects a non-converging retry loop: the model's edit had literally zero effect on the
    // verify outcome (exact same error text as the previous attempt). A weak model can burn its
    // whole maxAttempts budget re-applying a fix that provably doesn't work instead of noticing
    // and changing approach - this surfaces that signal explicitly instead of retrying blind.
    let previousVerifyError: string | undefined;
    let identicalFailureStreak = 0;
    // Whether ANY attempt in this run has produced a real file change yet. The checklist
    // grounding check below must only fire while this is still false - a VERIFY or REPORT step
    // legitimately marks itself "done" without touching a single file (there is nothing to edit
    // in a verification or a summary), and demoting those on an empty per-attempt diff would
    // punish entirely normal steps once EDIT already did its job in an earlier attempt.
    let anyFileChangedThisRun = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.currentAttempt = attempt;
      // Soft wall-clock budget: stop before starting another attempt once the deadline has passed
      // rather than burning further attempts. In-flight calls are never interrupted mid-way.
      if (deadline && Date.now() > deadline && attempt > 1) {
        this.emit("decision", `Time budget of ${opts.timeoutMs}ms exhausted after ${attempt - 1} attempt(s) - stopping.`, {
          attempt: attempt - 1,
          timeoutMs: opts.timeoutMs,
        });
        return finalize({
          success: false,
          verified: false,
          summary: `${lastSummary}\n\n[Stopped: time budget of ${opts.timeoutMs}ms exhausted after ${attempt - 1} attempt(s).]`,
          attempts: attempt - 1,
          conversationId,
          ...(verifyCommand ? { verifyCommand } : {}),
        });
      }

      this.emit("iteration", `Coding-Versuch ${attempt}/${maxAttempts}`, {
        attempt,
        maxAttempts,
        verifyCommand,
      });

      // Snapshot BEFORE the attempt touches anything, so every attempt is individually
      // reviewable and individually undoable. Taken per attempt rather than per edit: an
      // attempt is the unit the agent itself reasons in, and a checkpoint per file write
      // would bury the one the user actually wants under dozens of noise entries. An
      // attempt that changed nothing (the model only read/explored) has its empty
      // checkpoint discarded again when the attempt finishes, so the Changes tab lists
      // only attempts that actually touched files. The "Checkpoint erstellt" decision
      // event fires in the finally below - only for snapshots that survive.
      const checkpoint = this.sandboxRoot
        ? await createCheckpoint(this.sandboxRoot, `Before attempt ${attempt}: ${goal.slice(0, 80)}`)
        : undefined;

      try {

      const prompt =
        attempt === 1
          ? this.buildInitialPrompt(goal, verifyCommand, detectedSkill, plan, isResuming)
          : this.buildFollowUpPrompt(goal, lastSummary);
      // Follow-up prompts (buildFollowUpPrompt) never restate the phase contract - they go
      // straight to "diagnose and fix". Leaving currentPhase at whatever attempt 1 last saw
      // (possibly still "explore" if it timed out early) would permanently lock every retry
      // out of editing, since nothing in a follow-up prompt would ever move it forward again.
      if (attempt > 1) this.currentPhase = "edit";
      // The `deadline` check above only ever fires BETWEEN attempts - a single attempt can run
      // up to maxIterations tool-call iterations, and Agent's own progress timeout only catches
      // true stalls (it re-arms on every event, so a model that keeps doing SOMETHING, just
      // never converging, never trips it). Passing the remaining budget as a real per-attempt
      // ceiling closes that gap: Agent.run() already turns timeoutMsOverride into a hard,
      // abort-backed timeout (agent.ts's armTimeout/abortController), no new mechanism needed.
      const remainingMs = deadline ? deadline - Date.now() : undefined;
      // Snapshot BEFORE the model runs so the grounding check below (after the run) can tell
      // which checklist items THIS attempt newly marked "done" - the checkpoint diff is only
      // meaningful measured against that same attempt's edits, not the whole run's history.
      const todosBeforeAttempt = this.todos.snapshot();
      let runResult: AgentRunResult;
      try {
        runResult = await this.agent.run(prompt, {
          initialRunJournal: journal,
          getCurrentStepId: () => this.todos.currentStepId(),
          onModelResponse: (response) => this.updatePhaseFromResponse(response),
          ...(remainingMs && remainingMs > 0 ? { timeoutMsOverride: remainingMs } : {}),
        });
      } catch (error) {
        // Agent.run() surfaces its progress timeout as a THROWN error (the race in run()
        // rejects when the abort fires). Propagating that would surface as a 500/chat error to
        // the caller; a run that stopped making progress is a normal end state, so report it
        // as a clean CodingRunResult instead.
        const timeoutMessage = error instanceof Error ? error.message : String(error);
        if (/Agent timeout after/.test(timeoutMessage)) {
          this.emit("decision", "Versuch durch Fortschritts-Timeout abgebrochen - Lauf wird gestoppt.", {
            attempt,
            error: timeoutMessage,
          });
          return finalize({
            success: false,
            verified: false,
            summary: `${lastSummary}\n\n[Stopped: ${timeoutMessage}]`,
            attempts: attempt,
            conversationId,
            ...(verifyCommand ? { verifyCommand } : {}),
          });
        }
        throw error;
      }
      journal = runResult.runJournal ?? journal;
      lastSummary = runResult.response;

      // Extract and emit phase events from response
      this.extractAndEmitPhaseEvents(lastSummary, attempt);

      // Agent.run() aborted this attempt early via a guardrail - until now nothing here ever
      // looked at that, so an abort was silently treated exactly like a normal completion: the
      // checklist/verify logic below would run against whatever partial response the guardrail
      // produced, and either declare "success" on an aborted attempt or (for an explicit user
      // Stop) start ANOTHER attempt as if nothing happened. Two different outcomes needed:
      if (runResult.abortedReason === "user_stopped") {
        // The user asked this run to stop - starting another attempt (or even finalizing as a
        // normal "success") would ignore that. End here, honestly, with whatever happened.
        return finalize({
          success: false,
          verified: false,
          summary: lastSummary,
          attempts: attempt,
          conversationId,
          ...(verifyCommand ? { verifyCommand } : {}),
        });
      }
      if (
        (runResult.abortedReason === "stale_read_loop" ||
          runResult.abortedReason === "repeated_error_loop" ||
          runResult.abortedReason === "consecutive_tool_failures") &&
        attempt < maxAttempts
      ) {
        // These are recoverable stalls, not real failures or a stop request: the model got
        // stuck repeating one action (re-reading the same file, retrying the same failing call)
        // and the guardrail correctly cut that off before it burned the whole iteration budget.
        // Ending the RUN here (the previous behavior - nothing checked abortedReason at all)
        // is exactly the "the coding agent just stops" symptom this fixes: a stall is not a
        // dead end, it just needs a nudge to stop repeating and either act or conclude.
        this.emit(
          "decision",
          `Versuch ${attempt} durch Guardrail abgebrochen (${runResult.abortedReason}) - naechster Versuch mit Korrektur-Hinweis.`,
          { attempt, abortedReason: runResult.abortedReason }
        );
        const stallNote =
          runResult.abortedReason === "stale_read_loop"
            ? "you repeated the exact same read-only call(s) several times in a row without making any change or reaching a conclusion - that is a loop, not verification."
            : "you kept repeating the exact same tool call although it (or an identical one) already failed or was already answered.";
        lastSummary =
          `${lastSummary}\n\n[Attempt ${attempt} was aborted: ${stallNote} On this next attempt, do NOT repeat that exact action again. ` +
          `Either make a concrete, different change, or - if you are confident the work is already correct - say so explicitly ONCE ` +
          `("<< VERIFY COMPLETE - looks correct") and move on. Do not re-check the same thing twice.]`;
        continue;
      }

      // Ground the checklist against what the shadow-git checkpoint actually recorded: the
      // model is instructed never to mark a step "done" on the strength of an edit alone (see
      // buildInitialPrompt), but nothing enforced that until now - a model can call
      // todo:update(done) without having written anything. The checkpoint diff is the one
      // signal in this loop that reflects the real working tree rather than the model's own
      // account of it, so a "done" step with zero changed files is demoted back to in_progress
      // instead of being trusted at face value - but ONLY while this run has made no real
      // change yet at all. Once EDIT has genuinely written something in an earlier attempt,
      // later steps like VERIFY ("run a check") or REPORT ("summarize what changed") are
      // legitimately done without touching another file - demoting those on an empty diff would
      // punish entirely normal steps and could never converge (each such demotion re-opens the
      // checklist, which re-triggers the "checklist not finished" continuation below, forever).
      if (this.sandboxRoot && checkpoint) {
        const attemptDiff = await diffCheckpoint(this.sandboxRoot, checkpoint.sha);
        const changedFileCount = attemptDiff?.files.length ?? 0;
        if (changedFileCount > 0) anyFileChangedThisRun = true;
        if (changedFileCount === 0 && !anyFileChangedThisRun) {
          const newlyDone = this.todos
            .snapshot()
            .filter(
              (item) =>
                item.status === "done" &&
                todosBeforeAttempt.find((before) => before.id === item.id)?.status !== "done"
            );
          if (newlyDone.length > 0) {
            for (const item of newlyDone) {
              this.todos.update(
                item.id,
                "in_progress",
                'Als "done" gemeldet, aber der Checkpoint-Diff dieses Versuchs zeigt keine Dateiänderung - zurückgestuft.'
              );
            }
            this.emit(
              "decision",
              `Checkliste behauptete ${newlyDone.length} erledigte(n) Schritt(e) in Versuch ${attempt}, aber es wurden keine Dateien geändert - zurückgestuft auf "in_progress".`,
              { attempt, items: newlyDone.map((item) => item.title) }
            );
            lastSummary = `${lastSummary}\n\n[Checklist grounding: ${newlyDone.length} step(s) marked "done" were reset to "in_progress" - the checkpoint diff shows no file changes in this attempt, so the completion claim could not be confirmed: ${newlyDone.map((item) => item.title).join(", ")}]`;
          }
        }
      }

      if (!verifyCommand) {
        // No shell command to grade against, but the model's OWN checklist may still list
        // unfinished steps (typically VERIFY/REPORT) - accepting the run here regardless is
        // exactly "the agent just stopped" from the user's perspective: EDIT wrote a file and
        // the model's next response happened to contain no tool call, which the inner Agent
        // loop reads as "final answer" even though nothing actually verified or reported
        // anything. One bounded follow-up attempt asking the model to finish those steps
        // (self-check via shell/browser if available, then a REPORT) beats silently declaring
        // success on an incomplete checklist. Once the checklist is settled (or attempts run
        // out), fall through to the honest "unverified" result exactly as before.
        //
        // Gated on anyFileChangedThisRun: a model that never touches the checklist tool at all
        // (never calls todo:write/update, however unusual) would otherwise show "open items"
        // forever - that is absence of checklist discipline, not evidence of unfinished work,
        // and retrying would just burn the whole attempt budget for nothing. Real file changes
        // are the actual signal that the model was doing the task and got cut off mid-checklist.
        const openItems = this.todos.snapshot().filter((item) => item.status === "pending" || item.status === "in_progress");
        if (openItems.length > 0 && attempt < maxAttempts && anyFileChangedThisRun) {
          this.emit(
            "decision",
            `Keine Verifikation moeglich, aber ${openItems.length} Checklisten-Schritt(e) noch offen - fordere Fortsetzung an.`,
            { attempt, openItems: openItems.map((item) => item.title) }
          );
          lastSummary =
            `${lastSummary}\n\nNo verification command exists for this project, but your own checklist still has ` +
            `open step(s): ${openItems.map((item) => item.title).join(", ")}. Finish them - in particular VERIFY ` +
            `(if you have NOT already read the file(s) you wrote in this attempt, read them ONCE now, or run/open ` +
            `them via the shell or browser tool if possible; if you already read them, do NOT read them again - ` +
            `just judge what you already saw) and REPORT (summarize what changed and what you checked) - then STOP. ` +
            `State a clear PASS/FAIL conclusion in words; do not repeat any check you already performed this attempt.`;
          continue;
        }
        // Nothing to check against - report honestly that the result is unverified
        // instead of letting "no check" masquerade as a passing check.
        this.emit("decision", "Keine Verifikation moeglich - Ergebnis ist ungeprueft.", { attempt });
        return finalize({ success: true, verified: false, summary: lastSummary, attempts: attempt, conversationId });
      }

      const verifyResult = await this.agent.executor.execute("shell", {
        command: verifyCommand,
        // Without an explicit cwd the shell tool falls back to the server process's own
        // directory, so a sandboxed run would verify the wrong project entirely.
        ...(this.sandboxRoot ? { cwd: this.sandboxRoot } : {}),
      });
      if (verifyResult.success) {
        this.emit("decision", `Verifikation "${verifyCommand}" erfolgreich.`, { attempt, verifyCommand });
        return finalize({
          success: true,
          verified: true,
          summary: lastSummary,
          attempts: attempt,
          conversationId,
          verifyCommand,
        });
      }

      const verifyError = condenseVerifyOutput(verifyResult.error ?? JSON.stringify(verifyResult.data ?? ""));
      this.emit("decision", `Verifikation "${verifyCommand}" fehlgeschlagen.`, {
        attempt,
        verifyCommand,
        error: verifyError.slice(0, 500),
      });

      const isIdenticalToPreviousFailure = previousVerifyError !== undefined && verifyError.trim() === previousVerifyError.trim();
      identicalFailureStreak = isIdenticalToPreviousFailure ? identicalFailureStreak + 1 : 0;
      previousVerifyError = verifyError;

      if (identicalFailureStreak >= 2) {
        // Three attempts in a row produced the exact same verify error: the model's edits are
        // provably not changing the outcome. Burning the rest of maxAttempts would just repeat
        // this - stop now with a clear, honest diagnosis instead of a generic "failed" summary.
        this.emit("decision", "Abgebrochen: drei Versuche in Folge mit identischem Verifikationsfehler - keine Konvergenz erkennbar.", {
          attempt,
          verifyCommand,
        });
        return finalize({
          success: false,
          verified: false,
          summary: `${lastSummary}\n\n[Stopped: ${attempt} attempts in a row produced the exact same verification error - the edits are not changing the outcome:]\n${verifyError}`,
          attempts: attempt,
          conversationId,
          verifyCommand,
        });
      }

      lastSummary = isIdenticalToPreviousFailure
        ? `${lastSummary}\n\nVerification command "${verifyCommand}" failed with the EXACT SAME error as your previous attempt - your last change had NO effect on this outcome. Do not repeat it. Diagnose why that edit didn't fix this specific error, or try a fundamentally different approach:\n${verifyError}`
        : `${lastSummary}\n\nVerification command "${verifyCommand}" failed:\n${verifyError}`;

      if (attempt === maxAttempts) {
        return finalize({
          success: false,
          verified: false,
          summary: lastSummary,
          attempts: attempt,
          conversationId,
          verifyCommand,
        });
      }
      } finally {
        // No-op cleanup runs on EVERY exit path of the attempt (success, verify fail,
        // timeout, max attempts, non-convergence): if the working tree is unchanged since
        // the checkpoint, the attempt never wrote anything - drop the empty snapshot. The
        // decision event is only emitted when the snapshot survives.
        if (checkpoint) {
          const discarded = await discardNoopCheckpoint(this.sandboxRoot!, checkpoint.sha);
          if (!discarded) {
            this.emit("decision", `Checkpoint vor Versuch ${attempt} erstellt.`, {
              checkpoint_sha: checkpoint.sha,
              checkpoint_label: checkpoint.label,
              attempt,
            });
          }
        }
      }
    }

    return finalize({
      success: false,
      verified: false,
      summary: lastSummary,
      attempts: maxAttempts,
      conversationId,
      ...(verifyCommand ? { verifyCommand } : {}),
    });
  }

  /** Path filter for part-sequence bookkeeping: only sequences inside this run's sandbox. */
  private sandboxFilter(): ((path: string) => boolean) | undefined {
    if (!this.sandboxRoot) return undefined;
    const root = this.sandboxRoot.toLowerCase();
    return (path: string) => path.toLowerCase().startsWith(root);
  }

  /**
   * Self-healing for incomplete part sequences: runs ONE targeted follow-up attempt on the
   * same conversation that writes ONLY the missing parts (append with the exact
   * partNumber/totalParts the tool reported), instead of leaving the user with a warning and
   * a half-written file. Bounded to a single lightweight attempt - if it fails or leaves
   * sequences incomplete, the caller falls back to the warning path. Returns a short note
   * about the attempt (or null when it could not run at all).
   */
  private async healIncompleteSequences(
    incomplete: Array<{ path: string; totalParts: number; received: number; next: number }>,
    conversationId: number
  ): Promise<string | null> {
    // This is a targeted append-only fix-up with no explore/plan step of its own - the phase
    // lock would otherwise refuse its very first (and only) write.
    this.currentPhase = "edit";
    const lines = incomplete.map(
      (g) => `- ${g.path}: received ${g.received} of ${g.totalParts} parts, part ${g.next} is missing`
    );
    const prompt =
      `Some file-write sequences from the previous run are incomplete. Write ONLY the missing parts:\n\n` +
      lines.join("\n") +
      `\n\nRules:\n` +
      `1. Briefly read each file to see what was already written.\n` +
      `2. Write ONLY the missing parts using action:append partNumber:<n> totalParts:<m> in block form - <n> and <m> are exactly the values above. The active sequence checks ordering and rejects gaps or duplicates.\n` +
      `3. Do NOT modify any other files, do NOT re-write parts that were already written, and do not repeat anything.\n` +
      `4. If a file is already complete, leave it untouched.\n` +
      `5. After finishing, briefly confirm which files you completed.`;

    try {
      // The healing run ideally continues the same conversation so the fix-up is visible in
      // history. But it only needs the file state (it reads the file and appends the missing
      // parts), so a missing/unpersisted conversation must not block healing - fall back to
      // a fresh lightweight run in that case.
      try {
        await this.agent.loadConversation(conversationId);
      } catch {
        // Conversation not available - heal against file state alone.
      }
      // Explicit lightweight mode: skips the Agent-internal planning phase (the prompt above
      // already states exactly what to do) and caps iterations for this bounded fix-up.
      const healResult = await this.agent.run(prompt, { agentMode: "lightweight" });
      const detail = healResult.response?.trim().slice(0, 300) ?? "";
      return detail.length > 0 ? `Follow-up attempt: ${detail}` : "Follow-up attempt completed.";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("decision", "Self-Healing fehlgeschlagen - nur Warnung.", {
        part_heal_error: true,
        error: message.slice(0, 200),
      });
      return null;
    }
  }

  /**
   * Recovers the last plan + checklist state persisted for this conversation (see
   * persistEvent/emitPlanEvent), so resuming after a Stop continues where the run left off
   * instead of re-planning and restarting the checklist at step 1.
   *
   * Reads the conversation's full message history once, at the top of run() - only relevant
   * on resume, so this cost is paid once per resumed run, not on every iteration. Scans
   * newest-first and stops as soon as both pieces are found (or the history is exhausted).
   * A malformed/foreign event row is skipped rather than aborting the scan - this is a
   * best-effort recovery, not a hard requirement for the run to proceed.
   */
  /** Maps a TodoItem's status vocabulary onto PlanStep's - distinct enums for historical
   *  reasons (TodoList predates PlanStep having any per-step status at all), kept in sync here
   *  so a re-synced plan's step.status is at least meaningful rather than always "pending". */
  private static readonly TODO_TO_PLAN_STATUS: Record<TodoStatus, PlanStep["status"]> = {
    pending: "pending",
    in_progress: "running",
    done: "completed",
    blocked: "failed",
  };

  /**
   * Mirrors a checklist REWRITE (todo:write, i.e. TodoList.replace - see the TodoList
   * constructor wiring above) back into the Plan object the UI's Plan tab actually renders.
   *
   * Without this, the Plan tab and the checklist could silently diverge: the model is
   * explicitly instructed to call todo:write with a corrected step list once exploration shows
   * the drafted plan needs to change (see buildInitialPrompt's PLAN phase), but that never
   * touched `plan.steps` - the ORIGINAL plan stayed frozen in the "plan" event/DB row forever.
   * A step the model added, renamed, or dropped had no matching title in the old plan, so the
   * Plan tab either showed stale steps forever or failed to match up statuses for the new ones -
   * exactly the "plan looks like it reset / forgot to check something off" symptom this fixes.
   *
   * Deliberately narrow: only fires on a STRUCTURAL rewrite, never on a plain status tick
   * (see TodoList's onReplace vs onChange) - a plain todo:update is not a plan change and must
   * not re-emit/re-persist a "plan" event for every single status flip.
   */
  private syncPlanFromTodos(items: TodoItem[]): void {
    if (this.suppressPlanSync) return;
    const plan = this.currentPlan;
    if (!plan) return;

    // Title-matched against the CURRENT plan's steps (same rule TodoList.replace itself uses)
    // so a step whose title didn't change keeps its full metadata (description, dependsOn,
    // riskLevel, toolsNeeded) - only genuinely new/renamed titles fall back to a bare step.
    const byTitle = new Map(plan.steps.map((step) => [step.title.trim().toLowerCase(), step]));
    const steps: PlanStep[] = items.map((item) => {
      const existing = byTitle.get(item.title.trim().toLowerCase());
      const status = CodingAgent.TODO_TO_PLAN_STATUS[item.status] ?? "pending";
      if (existing) return { ...existing, title: item.title, status };
      return { id: `step_${item.id}`, title: item.title, description: "", status };
    });

    this.currentPlan = { ...plan, steps };
    this.emitPlanEvent(this.currentPlan);
  }

  private async loadPersistedState(
    conversationId: number
  ): Promise<{ plan?: Plan; todoItems?: Array<{ title: string; status: string; note?: string }> }> {
    let messages: Array<{ role: string; toolResult: string | null }> = [];
    try {
      // Defensively coerced to an array: a test/mock DatabaseService stub (or any future
      // implementation) that resolves getMessages() to undefined rather than throwing must
      // never crash resume - this is best-effort recovery, never a hard requirement.
      const result = await this.db.getMessages(conversationId);
      if (Array.isArray(result)) messages = result;
    } catch (error) {
      this.logger.warn("Failed to load persisted state for resume", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }

    let plan: Plan | undefined;
    let todoItems: Array<{ title: string; status: string; note?: string }> | undefined;
    for (let i = messages.length - 1; i >= 0 && (!plan || !todoItems); i--) {
      const row = messages[i];
      if (!row || row.role !== "event" || !row.toolResult) continue;
      let parsed: { eventType?: string; data?: Record<string, unknown> };
      try {
        parsed = JSON.parse(row.toolResult) as typeof parsed;
      } catch {
        continue;
      }
      if (!plan && parsed.eventType === "plan") {
        // __rawPlan (see emitPlanEvent) is the exact internal Plan object, never the flattened
        // UI-facing payload - so no shape reconstruction/guessing is needed here.
        const raw = parsed.data?.["__rawPlan"] as Plan | undefined;
        if (raw && typeof raw.goal === "string" && Array.isArray(raw.steps)) plan = raw;
      }
      if (!todoItems && parsed.eventType === "decision") {
        const rawItems = parsed.data?.["todo_items"];
        if (Array.isArray(rawItems) && rawItems.length > 0) {
          const mapped = rawItems
            .map((entry) => {
              const item = (entry ?? {}) as { title?: unknown; status?: unknown; note?: unknown };
              if (typeof item.title !== "string" || !item.title.trim()) return undefined;
              return {
                title: item.title,
                status: typeof item.status === "string" ? item.status : "pending",
                ...(typeof item.note === "string" ? { note: item.note } : {}),
              };
            })
            .filter((x): x is { title: string; status: string; note?: string } => x !== undefined);
          if (mapped.length > 0) todoItems = mapped;
        }
      }
    }
    return { plan, todoItems };
  }

  /**
   * Persists one CodingAgent event as a `role:"event"` conversation message, same shape
   * Agent.run()'s own internal emit() writes (agent.ts) - so CodingWorkspace's existing message
   * mapping (which already whitelists "plan"/"decision"/etc, see CodingWorkspace.tsx) picks these
   * up on reload with NO frontend change needed.
   *
   * Without this, every CodingAgent event (plan, todo/decision, phase) was a pure WebSocket
   * broadcast with no DB row at all - live-visible while the tab stayed open, but gone the
   * moment the conversation was reloaded (switching projects, refreshing the page, or resuming
   * after a stop): the Plan tab found nothing to reconstruct and looked like the plan had been
   * lost, even though the run itself had continued correctly. Queued (not awaited) so a slow
   * write never delays the run loop, and ordered so persisted rows land in emission order.
   */
  private persistEvent(eventType: string, message: string, data: Record<string, unknown> | undefined, timestamp: string): void {
    if (this.currentConversationId === undefined) return;
    const conversationId = this.currentConversationId;
    const toolResult = JSON.stringify({ eventType, data, timestamp });
    this.eventPersistQueue = this.eventPersistQueue.then(() =>
      this.db
        .addMessage({ conversationId, role: "event", content: message, toolResult, createdAt: timestamp })
        .then(() => undefined)
        .catch(() => {
          // Best-effort: a lost event row means degraded resume/reload fidelity, never a
          // reason to interrupt the run itself.
        })
    );
  }

  private emit(type: "iteration" | "decision" | "phase_started" | "phase_completed" | "phase_failed", message: string, data?: Record<string, unknown>): void {
    const eventType: "iteration" | "decision" | "internal_instruction" = type === "iteration" ? "iteration" : type === "decision" ? "decision" : "internal_instruction";
    const timestamp = new Date().toISOString();
    try {
      this.eventEmitter?.emitEvent({ type: eventType, message, data, timestamp });
    } catch {
      // Event delivery is best-effort telemetry - never let it abort a coding run.
    }
    this.persistEvent(eventType, message, data, timestamp);
  }

  /** Emits the Planner's structured plan as a "plan" event, the same payload shape agent.ts's
   *  plan mode uses - CodingPlanPanel filters only on eventType==="plan" with goal+steps, not on
   *  `source`, so this is picked up without any UI change. */
  private emitPlanEvent(plan: Plan): void {
    const payload = toPlanEventPayload(plan, formatPlanAsMarkdown(plan));
    // __rawPlan carries the exact internal Plan object (dependsOn/riskLevel/toolsNeeded, the
    // step id scheme, everything) alongside the UI-shaped payload above - so a later run() on
    // the same conversation can rehydrate the EXACT plan it already had (see loadPersistedState)
    // instead of reconstructing an approximation from the flattened UI fields, or re-planning
    // from scratch and losing whatever the user already saw progress on. The UI ignores the
    // extra field; it never had a reason to look for it.
    const data = { ...payload, source: "coding_agent", __rawPlan: plan };
    const message = `Plan: ${plan.goal}`;
    const timestamp = new Date().toISOString();
    try {
      this.eventEmitter?.emitEvent({ type: "plan" as AgentRunEventType, message, data, timestamp });
    } catch {
      // Event delivery is best-effort telemetry - never let it abort a coding run.
    }
    this.persistEvent("plan", message, data, timestamp);
  }

  private emitPhase(event: CodingPhaseEvent): void {
    // Deduplicate: started=1, completed=2 (failed=2). A phase must never regress - the live
    // emission path (updatePhaseFromResponse) and the end-of-attempt backfill
    // (extractAndEmitPhaseEvents) both call this, and without this guard the backfill would
    // re-emit "started" after the live path already emitted "completed", rewinding the phase
    // bar. A duplicate also costs an extra DB row + WS event for no information.
    const rank = event.type === "phase_started" ? 1 : 2;
    const previous = this.livePhaseEmitted.get(event.phase);
    if (previous !== undefined && previous.rank >= rank) {
      // A duplicate COMPLETED event from the end-of-attempt backfill can carry the text the
      // model wrote between the phase markers - which the live path (updatePhaseFromResponse)
      // did not extract, so the previously-emitted row lacks it. Merge that text in as a
      // supplementary result row instead of dropping it (and instead of emitting a confusing
      // second "phase completed" in the activity log).
      this.mergePhaseResultIfRicher(event, previous);
      return;
    }
    this.livePhaseEmitted.set(event.phase, {
      rank,
      hasResult: typeof event.result === "string" && event.result.trim().length > 0,
      hasError: typeof event.error === "string" && event.error.trim().length > 0,
    });

    const message = `${event.title}${event.description ? ': ' + event.description : ''}`;
    const data = {
      phase_event: event.type,
      phase: event.phase,
      title: event.title,
      description: event.description,
      result: event.result,
      error: event.error,
      attempt: event.attempt,
    };
    try {
      this.eventEmitter?.emitEvent({ type: "internal_instruction" as const, message, data, timestamp: event.timestamp });
    } catch {
      // Event delivery is best-effort telemetry - never let it abort a coding run.
    }
    this.persistEvent("internal_instruction", message, data, event.timestamp);
  }

  /**
   * Persists the `result`/`error` text of a duplicate completed phase event that the already
   * emitted row lacked, without re-emitting the "phase completed" transition itself.
   *
   * `phase_event: "phase_result"` is deliberately NOT in the phase bar's known set
   * (started/completed/failed - see findLatestPhaseProgress), so the bar ignores it; the
   * Activity tab renders it as a normal internal_instruction row whose data carries the text.
   * Bounded by the tracking map: a second backfill with the same text is a no-op.
   */
  private mergePhaseResultIfRicher(
    event: CodingPhaseEvent,
    previous: { rank: number; hasResult: boolean; hasError: boolean }
  ): void {
    // A started event carries no result/error worth merging, and a failed event is not the
    // "content between markers" case this exists for.
    if (event.type !== "phase_completed") return;

    const result = typeof event.result === "string" && event.result.trim().length > 0 ? event.result.trim() : undefined;
    const error = typeof event.error === "string" && event.error.trim().length > 0 ? event.error.trim() : undefined;
    if (!result && !error) return;

    // Nothing new worth persisting if the already-emitted row carried all of this.
    const newResult = result !== undefined && !previous.hasResult;
    const newError = error !== undefined && !previous.hasError;
    if (!newResult && !newError) return;

    this.livePhaseEmitted.set(event.phase, {
      rank: previous.rank,
      hasResult: previous.hasResult || newResult,
      hasError: previous.hasError || newError,
    });

    const message = `${event.title} - Ergebnis`;
    const data = {
      phase_event: "phase_result",
      phase: event.phase,
      title: event.title,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
      attempt: event.attempt,
    };
    try {
      this.eventEmitter?.emitEvent({ type: "internal_instruction" as const, message, data, timestamp: event.timestamp });
    } catch {
      // Event delivery is best-effort telemetry - never let it abort a coding run.
    }
    this.persistEvent("internal_instruction", message, data, event.timestamp);
  }

  private extractAndEmitPhaseEvents(response: string, attempt: number): void {
    const phases: Array<"explore" | "plan" | "edit" | "verify" | "report"> = ["explore", "plan", "edit", "verify", "report"];
    const phaseDescriptions: Record<string, string> = {
      explore: "Lokalisieren und Lesen relevanter Dateien",
      plan: "Planen der zu ändernden Dateien",
      edit: "Durchführen der Änderungen",
      verify: "Verifizierung der Änderungen",
      report: "Zusammenfassung der Änderungen",
    };

    for (const phase of phases) {
      const startMarker = `>> PHASE: ${phase.toUpperCase()}`;
      const endMarker = `<< ${phase.toUpperCase()} COMPLETE`;

      const startIdx = response.indexOf(startMarker);
      const endIdx = response.indexOf(endMarker);

      if (startIdx !== -1) {
        this.emitPhase({
          type: "phase_started",
          phase,
          title: phase.charAt(0).toUpperCase() + phase.slice(1),
          description: phaseDescriptions[phase],
          timestamp: new Date().toISOString(),
          attempt,
        });
      }

      if (endIdx !== -1) {
        // Extract content between start and end markers
        const contentStart = startIdx !== -1 ? startIdx + startMarker.length : 0;
        const content = response.substring(contentStart, endIdx !== -1 ? endIdx : response.length).trim();

        this.emitPhase({
          type: "phase_completed",
          phase,
          title: phase.charAt(0).toUpperCase() + phase.slice(1),
          result: content.slice(0, 500), // Keep first 500 chars of result
          timestamp: new Date().toISOString(),
          attempt,
        });
      }
    }
  }

  /**
   * Turns a bare goal into an explicit phase contract. Previously the goal string was
   * handed to the agent verbatim, so "explore before editing" and "this exact command
   * decides success" existed only in the system directive - the agent had no way to know
   * which command its work would actually be judged by.
   */
  /**
   * Renders one plan step with its metadata, not just title/description.
   *
   * The Planner already computes dependsOn (ordering constraints), riskLevel and toolsNeeded
   * for every step - PlanStep carries all of it - but until now only title and description
   * ever reached the executing model; the rest was computed and then silently discarded. A
   * step marked high-risk got no different treatment than a trivial one, and a step that
   * depends on an earlier one carried no signal that order matters.
   */
  private renderPlanStep(step: PlanStep, index: number): string {
    const line = `${index + 1}. ${step.title}${step.description ? ` - ${step.description}` : ""}`;
    const meta: string[] = [];
    if (step.dependsOn && step.dependsOn.length > 0) meta.push(`depends on: ${step.dependsOn.join(", ")}`);
    if (step.riskLevel && step.riskLevel !== "low") meta.push(`risk: ${step.riskLevel}`);
    if (step.toolsNeeded && step.toolsNeeded.length > 0) meta.push(`tools: ${step.toolsNeeded.join(", ")}`);
    return meta.length > 0 ? `${line} [${meta.join(" · ")}]` : line;
  }

  /** Shared with buildFollowUpPrompt (see there for why this must not be initial-attempt-only). */
  private pathHandlingBlock(): string[] {
    if (!this.sandboxRoot) return [];
    return [
      `Project root: ${this.sandboxRoot}`,
      "",
      "CRITICAL PATH HANDLING:",
      `- ONLY use RELATIVE paths from the project root (e.g., 'src/index.ts', 'package.json', 'docs/README.md')`,
      `- NEVER use absolute paths (no leading /)`,
      `- NEVER include 'shared-workspace' or 'coding' in your file paths`,
      `- ALL file operations (filesystem AND shell) are automatically scoped to ${this.sandboxRoot}`,
      `- Examples of CORRECT paths: 'index.html', 'src/app.ts', 'config/settings.json'`,
      `- Examples of WRONG paths: '/apps/server/...', 'shared-workspace/...', 'coding/...'`,
      "",
    ];
  }

  private buildInitialPrompt(
    goal: string,
    verifyCommand: string | undefined,
    detectedSkill: string | undefined,
    plan: Plan,
    isResuming: boolean
  ): string {
    const parts: string[] = [`Goal: ${goal}`, "", ...this.pathHandlingBlock()];

    if (isResuming) {
      parts.push(
        "",
        "CONTINUATION IN AN EXISTING PROJECT - this conversation and project already exist.",
        "Before you edit anything, use EXPLORE to understand what is already here: list the",
        "root directory, read key files (package.json, index.html, main entry points), and",
        "check existing stylesheets. Do NOT create new files that duplicate existing ones.",
        "Do NOT overwrite files blindly - read them first in the EXPLORE phase. The plan",
        "below was drafted WITHOUT knowledge of the current project state, so you MUST",
        "validate and adjust it in the PLAN phase after exploration. Skip steps that are",
        "already done (e.g. if there is already a CSS file, do not create another one).",
        "The status tool can tell you what files your previous runs changed - use it.",
        "",
      );
    }

    parts.push(
      "Track your progress with the todo tool: it already contains the plan below as pending steps.",
      "Mark a step in_progress before starting it and done once it is verified. That checklist is what",
      "the user sees, so keep it truthful - never mark a step done on the strength of an edit alone,",
      "only once diagnostics or the verification command confirmed it.",
      "",
      "The status tool gives you a one-call snapshot of your current phase, checklist, open diagnostic",
      "errors, and what files have actually changed this attempt. Use it after a few edits when you need",
      "to confirm what still needs work - it is faster than re-reading files or recounting from history.",
      "",
      "A planning subagent already analyzed this goal and drafted the following plan:",
      "",
      plan.steps.map((step, i) => this.renderPlanStep(step, i)).join("\n"),
      "",
      "Work in these phases, and EXPLICITLY STATE the phase you are starting and completing:",
      "1. EXPLORE - locate the relevant files and read them before changing anything.",
      "   At start: \">> PHASE: EXPLORE\"",
      "   At end: \"<< EXPLORE COMPLETE\"",
      "2. PLAN - review the draft plan above against what you found in EXPLORE. Name the exact files",
      "   you will edit and what changes each one needs. If exploration shows the draft needs to",
      "   change (a step is unnecessary, missing, or targets the wrong file), call todo action:\"write\"",
      "   with the corrected steps - do not silently ignore the draft, adjust it explicitly.",
      "   At start: \">> PHASE: PLAN\"",
      "   At end: \"<< PLAN COMPLETE\"",
      "3. EDIT - make minimal, targeted edits (prefer the filesystem tool's \"edit\" action).",
      "   At start: \">> PHASE: EDIT\"",
      "   At end: \"<< EDIT COMPLETE\"",
      "4. VERIFY - re-read what you changed and run the verification command below.",
      "   At start: \">> PHASE: VERIFY\"",
      "   At end: \"<< VERIFY COMPLETE\"",
      "5. REPORT - list the files you changed and what the verification showed.",
      "   At start: \">> PHASE: REPORT\"",
      "   At end: \"<< REPORT COMPLETE\""
    );

    if (verifyCommand) {
      parts.push(
        "",
        `Verification command: \`${verifyCommand}\`. Its exit code decides whether this run counts as successful, so make it pass - do not declare success without running it.`
      );
    } else {
      parts.push(
        "",
        "No verification command could be determined for this project. Pick the most appropriate check yourself (build, test, or type-check) via the shell tool and state which one you used."
      );
    }

    if (detectedSkill) {
      parts.push(
        "",
        `A "${detectedSkill}" skill looks relevant for this goal - load it via the skill tool before phase 3 and follow it if it applies.`
      );
    }

    return parts.join("\n");
  }

  private buildFollowUpPrompt(goal: string, previousSummaryWithVerification: string): string {
    // The checklist carries across attempts. Each attempt is a fresh agent.run(), so without
    // replaying it here the agent would re-plan from scratch and redo steps it already finished.
    const checklist = this.todos.render();
    return [
      "Your previous attempt did not pass verification. Diagnose the ACTUAL failure below and fix it - do not repeat the same approach blindly.",
      "",
      "BEFORE YOU ACT, call the status tool. It tells you in one call what normally takes several reads: which steps are already done (from the checklist), what files you actually changed (from the checkpoint diff - not your memory), and whether any diagnostics are still failing. Your conversation context may have been trimmed and earlier results may no longer be visible, so do NOT rely on what you remember - ask the status tool for ground truth.",
      this.pathHandlingBlock().join("\n"),
      `Original goal: ${goal}`,
      checklist ? `Your checklist so far (keep updating it, do not start it over):\n${checklist}` : "",
      "Previous attempt summary and verification output:",
      previousSummaryWithVerification,
    ].filter((part) => part !== "").join("\n\n");
  }
}

export function createCodingAgent(
  provider: LLMProvider,
  db: DatabaseService,
  eventEmitter?: AgentEventEmitter,
  options?: CodingAgentOptions
): CodingAgent {
  return new CodingAgent(provider, db, eventEmitter, options);
}
