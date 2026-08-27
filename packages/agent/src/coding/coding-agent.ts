import type { LLMProvider } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import type { ToolExecutor, ToolResult } from "@ducki/shared";
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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, isAbsolute, basename } from "node:path";
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
import { createExploreTool, type ExploreToolOptions } from "./explore-tool.js";
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

## Delegate substantial specialist work
If a "delegate_to_bot" tool is available, use it selectively for a clearly bounded, substantial
frontend or backend work package. Use frontend-developer for HTML/CSS/browser JS/TS/UI work and
backend-infrastructure for project structure, Node.js/backend TS, PHP, Python, APIs, databases, and
repository infrastructure. Do small or tightly coupled edits yourself. Delegation is synchronous:
wait for the specialist, then inspect the actual files/diff and independently verify the result.
Never accept a specialist's prose claim as proof that its edits or tests succeeded.

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

/**
 * Further-restricted subset of CODING_ALLOWED_SHELL_COMMANDS with zero filesystem/state side
 * effects - used only during CodingAgent's Plan-Mode exploration (see planOnlyExploreActive).
 * Excludes mkdir/touch (create files/dirs) and every toolchain runner (npm/npx/pnpm/tsc/...),
 * any of which can install packages, write build output, or run an arbitrary project script -
 * exactly what "Plan Mode changes nothing" promises never happens.
 */
const PLAN_ONLY_EXPLORE_READONLY_SHELL_COMMANDS = new Set([
  "ls", "dir", "pwd", "cd", "cat", "type", "grep", "rg", "find", "head", "tail", "wc", "echo", "which", "where",
]);

/** Git actions with no repository side effects - used the same way as the shell allowlist above.
 *  Excludes add/commit/push/pull/clone/checkout/init, all of which mutate the working tree,
 *  history, or (checkout) which files are even present. */
const PLAN_ONLY_EXPLORE_READONLY_GIT_ACTIONS = new Set(["status", "diff", "log", "branch"]);

/** How many EXPLORE-phase tool-call iterations Plan-Mode's investigation sub-run gets before it
 *  is cut off and the Planner is called with whatever was learned so far. Small on purpose: this
 *  is meant to ground the plan in a quick look at the project, not to run a full exploration -
 *  a goal that genuinely needs more than this benefits more from actually being executed. */
const PLAN_ONLY_EXPLORE_MAX_ITERATIONS = 12;

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
  explorerProfileResolver?: ExploreToolOptions["resolveProfile"];
  /**
   * Hard wall-clock budget for ONE explore call, in milliseconds. The explore sub-agent shares
   * the run loop's stale-read loop guardrail, but a slow-but-busy exploration could otherwise
   * block this coding run for its whole iteration budget - this caps that. Default:
   * DUCKI_EXPLORE_TIMEOUT_MS or 3 minutes.
   */
  exploreTimeoutMs?: number;
  /**
   * This server's own origin (e.g. "http://127.0.0.1:3001"), used to tell the model the real
   * HTTP URL for previewing/testing this project in the browser tool. Without it, a model asked
   * to "look at the project in the browser" has only `sandboxRoot` (an absolute filesystem path)
   * to go on and improvises a `file://` URL - which loads (Puppeteer does not block it), but ES
   * module scripts and fetch() are blocked under file: by the browser's own CORS rules, so the
   * page silently fails in ways that look identical to a real bug in the project.
   */
  previewBaseUrl?: string;
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
  planRunContext?: { planId?: number | null; planVersion?: number; runId: string };
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
  /**
   * Streams each attempt's response text as it arrives from the model, instead of the caller
   * only finding out once the WHOLE iteration (LLM call + any tool calls) has finished. Without
   * this CodingAgent never passed `stream: true` down to Agent.run() at all - every coding run,
   * unlike the regular chat, always used the blocking generate() path, so the UI's "it's writing
   * live" indicator only ever had something to show once a full response had already landed.
   */
  onChunk?: (chunk: string) => void;
  /**
   * Whether this run is expected to persist a project change. Coding runs default to true;
   * callers that deliberately use CodingAgent for a read-only audit/review must opt out.
   * This is an execution contract, not a hint to the model: a run that expects a mutation
   * cannot complete successfully until the checkpoint diff proves that one happened.
   */
  mutationExpected?: boolean;
  /**
   * "Plan Mode": create/refresh the plan, seed the checklist, report it - then return WITHOUT
   * ever entering the EXPLORE/EDIT/VERIFY attempt loop. No filesystem/shell tool call happens at
   * all, so nothing about the project can change. Implies mutationExpected:false unless the
   * caller explicitly overrides it (a plan-only run was never going to touch a file, so the
   * completion contract must not demand one).
   */
  planOnly?: boolean;
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
  /** Machine-readable terminal state. `success` is retained for API compatibility. */
  completionStatus?: "completed_verified" | "completed_unverified" | "incomplete" | "failed";
  /** Evidence used by the controller for the completion decision. Never model-authored. */
  completionEvidence?: {
    mutationExpected: boolean;
    fileChangesObserved: boolean;
    changedFiles: string[];
    openChecklistItems: string[];
  };
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
 * Checklist-title classifiers for the checkpoint-grounding check in run(): a step whose title
 * matches this is assumed to require a file change to be genuinely "done" (checked first, so a
 * mixed title like "fix the bug and verify" is still treated as construction, not exempted).
 */
const CHECKLIST_CONSTRUCTION_KEYWORDS =
  /\b(write|add|create|implement|build|fix|refactor|update|remove|delete|rename|install|configure|integrate|migrate|style)\b/i;
/**
 * A step whose title matches this (and NOT the construction list above) can legitimately be
 * "done" without touching a file this attempt - e.g. VERIFY/REPORT steps, or a diagnostic step
 * like "reproduce the error in the browser". See the grounding check in run() for how these two
 * lists are combined.
 */
const CHECKLIST_CHECK_KEYWORDS =
  /\b(verify|test|check|report|review|confirm|validate|investigate|explore|research|reproduce|diagnose|analyze|understand|inspect|read)\b/i;

/**
 * Whole-plan version of the same classifier: does ANY step look like it needs a real file
 * change to be genuinely done? Same precedence as the per-step check (construction wins over
 * check, unrecognized defaults to "yes, needs evidence") - used to decide the RUN's overall
 * mutationExpected instead of hardcoding it, so a plan made entirely of explore/inspect/
 * diagnose-type steps is not held to a mutation requirement none of its steps ever implied.
 */
function planRequiresMutation(plan: Plan): boolean {
  return plan.steps.some((step) => {
    if (CHECKLIST_CONSTRUCTION_KEYWORDS.test(step.title)) return true;
    if (CHECKLIST_CHECK_KEYWORDS.test(step.title)) return false;
    return true;
  });
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
 * Blanks out line/column numbers (`:123:45`, `line 123`) before the identical-failure-streak
 * comparison in run(). Line numbers shift on every edit even when the underlying error is
 * unchanged, so comparing raw text under-counts genuine non-convergence; this keeps the
 * comparison in run() free of that noise without touching what's actually shown to the model.
 */
function normalizeVerifyErrorForComparison(text: string): string {
  return text.replace(/:\d+:\d+/g, ":N:N").replace(/\bline \d+\b/gi, "line N");
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
  private readonly previewBaseUrl: string | undefined;
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
   * True only while Plan-Mode's own investigation sub-run (see run()'s planOnly branch) is in
   * flight - read by the coding-plan-only-explore-lock hook below. Unlike the normal phase lock,
   * this has no bypass-after-N-refusals escape hatch: "Plan Mode changed nothing" is a promise
   * made to the user, not just an internal discipline nudge a stubborn model may eventually
   * override.
   */
  private planOnlyExploreActive = false;
  /** Tool-call budget consumed so far during the CURRENT Plan-Mode investigation sub-run - reset
   *  each time one starts. Counts every tool call (not just refused ones) so a model that keeps
   *  investigating forever still gets cut off - see PLAN_ONLY_EXPLORE_MAX_ITERATIONS. */
  private planOnlyExploreToolCalls = 0;
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
  private currentPlanRunContext: CodingRunOptions["planRunContext"];
  /** Serializes this instance's own event-persistence writes so row order in the DB matches
   *  emission order, without making any emit() call itself await the write - same pattern as
   *  Agent.run()'s internal eventPersistQueue (agent.ts), applied here because CodingAgent now
   *  persists its OWN events (plan/decision/phase) independently of that one. */
  private eventPersistQueue: Promise<void> = Promise.resolve();
  /** The plan currently backing this run - mutable (unlike a `const plan` in run()) so
   *  syncPlanFromTodos can update it in place when the model rewrites the checklist. Undefined
   *  before run() computes/rehydrates a plan. */
  private currentPlan: Plan | undefined;
  /** The `plans` table row id/version currentPlan was persisted as (see persistPlan in run()) -
   *  undefined when persistence failed or the plan came from opts.existingPlan (already has its
   *  own id from wherever it was loaded, and this instance never re-persists someone else's
   *  row). Read by syncPlanFromTodos to keep that row's step statuses live as the checklist
   *  changes - see this.currentPlanDbId's doc comment there for why that matters. */
  private currentPlanDb: { id: number; version: number } | undefined;

  private buildRepositorySnapshot(): Record<string, unknown> | undefined {
    if (!this.sandboxRoot || !existsSync(this.sandboxRoot)) return undefined;
    const ignored = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);
    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 3 || files.length >= 300) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (ignored.has(entry.name) || files.length >= 300) continue;
        const absolute = join(dir, entry.name);
        const relative = absolute.slice(this.sandboxRoot!.length + 1).replace(/\\/g, "/");
        if (entry.isDirectory()) walk(absolute, depth + 1);
        else files.push(relative);
      }
    };
    try { walk(this.sandboxRoot, 0); } catch { /* partial snapshot is still useful */ }
    let packageInfo: Record<string, unknown> | undefined;
    const packagePath = join(this.sandboxRoot, "package.json");
    if (existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
        packageInfo = { name: parsed["name"], scripts: parsed["scripts"], dependencies: parsed["dependencies"], devDependencies: parsed["devDependencies"] };
      } catch { /* malformed package.json will be discovered during execution */ }
    }
    return { root: this.sandboxRoot, files, package: packageInfo, hasTsconfig: existsSync(join(this.sandboxRoot, "tsconfig.json")) };
  }
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
    this.previewBaseUrl = options.previewBaseUrl;
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
        // Status is part of the plan's ground truth too. Previously only todo:write (structural
        // replacement) reached the Plan object, while ordinary todo:update calls changed only
        // the checklist. That let the Plan panel say "pending" after the checklist said "done".
        this.syncPlanFromTodos(items);
      },
      undefined
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
        // Runs before every other discipline hook (highest priority) so nothing else - not the
        // phase lock's one-time bypass, not the shell-approval allowlist - gets a chance to let
        // a call through first. Only active during CodingAgent's own Plan-Mode investigation
        // sub-run (see run()); a completely inert no-op the rest of the time.
        name: "coding-plan-only-explore-lock",
        priority: 100,
        handler: async (context: any) => {
          if (!this.planOnlyExploreActive) return { proceed: true };
          const toolName = context.toolName as string;
          const input = (context.input as Record<string, unknown>) ?? {};

          this.planOnlyExploreToolCalls++;
          if (this.planOnlyExploreToolCalls > PLAN_ONLY_EXPLORE_MAX_ITERATIONS) {
            return {
              proceed: false,
              reason:
                "Plan-Modus: Recherche-Budget aufgebraucht. Rufe kein weiteres Tool auf - fasse jetzt " +
                "in Worten zusammen, was du fuer die Planung herausgefunden hast.",
            };
          }

          if (toolName === "filesystem") {
            const action = String(input["action"] ?? "").toLowerCase();
            if (MUTATING_FILESYSTEM_ACTIONS.has(action)) {
              return {
                proceed: false,
                reason:
                  `Plan-Modus: nur Recherche, keine Ausfuehrung - dieser Lauf erstellt nur einen Plan und ` +
                  `aendert keine Dateien. Verwende "read"/"grep"/"glob"/"outline"/"list" statt "${action}".`,
              };
            }
            return { proceed: true };
          }
          if (toolName === "git") {
            const action = String(input["action"] ?? "").toLowerCase();
            if (!PLAN_ONLY_EXPLORE_READONLY_GIT_ACTIONS.has(action)) {
              return {
                proceed: false,
                reason: `Plan-Modus: git-Aktion "${action}" ist hier read-only-beschraenkt (erlaubt: status, diff, log, branch).`,
              };
            }
            return { proceed: true };
          }
          if (toolName === "shell") {
            const command = String(input["command"] ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
            if (!PLAN_ONLY_EXPLORE_READONLY_SHELL_COMMANDS.has(command)) {
              return {
                proceed: false,
                reason:
                  `Plan-Modus: Shell-Befehl "${command}" ist hier nicht erlaubt - nur reine Lesebefehle ` +
                  `(ls, cat, grep, find, ...), kein Build/Install/Test.`,
              };
            }
            return { proceed: true };
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
      {
        // A live browser session (the model's own, or one the user started and the agent is
        // only observing) can go stale the moment a file it depends on changes on disk - the
        // page keeps showing whatever it rendered on its last load/reload. Marking the session
        // dirty here (instead of forcing an immediate reload) lets the browser tool's read-only
        // inspection actions (evaluate, get_content, get_page_errors, screenshot, snapshot,
        // expect - see reloadIfDirty in packages/tools/src/browser.ts) reload exactly once,
        // right before the NEXT time something actually looks at the page. A session nobody is
        // currently inspecting, or one the agent only watches without ever touching its files,
        // is never reloaded - a user's live session stays untouched unless the agent's own edit
        // is what invalidated it.
        name: "coding-browser-staleness-tracker",
        priority: 50,
        handler: async (context: any) => {
          const toolName = context.toolName as string;
          if (toolName !== "filesystem") return { proceed: true };
          const result = context.result as { success: boolean } | undefined;
          if (!result?.success) return { proceed: true };
          const action = String((context.input as Record<string, unknown> | undefined)?.["action"] ?? "");
          if (action !== "write" && action !== "edit" && action !== "append") return { proceed: true };
          // Best-effort: no browser session may exist yet, and that's fine (mark_dirty no-ops
          // in that case) - a coding run must never fail or slow down because of this signal.
          await this.agent.executor.execute("browser", { action: "mark_dirty" }).catch(() => undefined);
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
      ...(options.explorerProfileResolver ? { resolveProfile: options.explorerProfileResolver } : {}),
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
    };

    const goalLower = goal.toLowerCase();
    for (const [skill, keywords] of Object.entries(skillKeywords)) {
      // Word-boundary match, not substring: `includes("test")` also matched "latest"/"fastest",
      // and `includes("fix")` matched "prefix"/"suffix", mis-selecting a skill (and, via
      // verifyCommand detection above, its side effects) on goals that merely contain the
      // substring rather than the word.
      if (keywords.some(kw => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(goalLower))) {
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
    // Non-Node ecosystems: one well-known, non-mutating check command per toolchain marker file -
    // same "never fabricate a command that would fail for unrelated reasons" rule as above, so
    // this only fires when the marker file makes the toolchain unambiguous.
    if (existsSync(join(this.sandboxRoot, "Cargo.toml"))) return "cargo check";
    if (existsSync(join(this.sandboxRoot, "go.mod"))) return "go build ./...";
    if (existsSync(join(this.sandboxRoot, "pyproject.toml")) || existsSync(join(this.sandboxRoot, "requirements.txt"))) {
      return "python -m compileall -q .";
    }
    return undefined;
  }

  /**
   * A plain HTML/CSS/JS project (no tsconfig.json, no package.json build script) has no shell
   * command to grade against, so detectDefaultVerifyCommand() returns undefined and every such
   * run previously fell straight into "no verification possible" - leaving a checklist step like
   * "Teste im Browser" entirely dependent on the model remembering to call the browser tool
   * itself (it often doesn't). This finds the static entry point so runBrowserVerify() can supply
   * a REAL, non-shell verification for exactly that case. Only these two conventional
   * locations, deliberately - scanning further risks guessing wrong and "verifying" the wrong
   * page. `public/index.html` is included alongside the root because it is the standard static
   * entry point for a plain (non-bundled) project scaffolded with that layout - without it,
   * every such project fell through to "no verification possible" exactly like the root-only
   * case this was originally written to fix.
   *
   * Requires previewBaseUrl: without it there is no real HTTP URL to load the page from, and
   * loading it via a `file://` URL instead would silently break any ES module script or fetch()
   * call (Chromium blocks both under file:, per the BROWSER PREVIEW note in buildFooter below) -
   * reporting made-up "errors" that are really just the CORS restriction, not a real bug in the
   * project. previewBaseUrl is only ever set by the real server wiring, never by a bare
   * `new CodingAgent(...)` construction (as every existing unit test does), so this also keeps
   * unit tests from unexpectedly launching a real headless browser.
   */
  private detectStaticEntryFile(): string | undefined {
    if (!this.sandboxRoot || !this.previewBaseUrl) return undefined;
    if (existsSync(join(this.sandboxRoot, "index.html"))) return "index.html";
    if (existsSync(join(this.sandboxRoot, "public", "index.html"))) return "public/index.html";
    return undefined;
  }

  /**
   * Loads `entryFile` in the shared browser tool (via the real HTTP preview route - see
   * detectStaticEntryFile) and reports console errors, uncaught page exceptions, and failed
   * requests captured during that load - the same signal a human would get from opening
   * devtools. Returns a ToolResult so the caller can feed it through the exact same
   * success/failure/retry handling as a shell verifyCommand's result (see run()).
   */
  private async runBrowserVerify(entryFile: string): Promise<ToolResult> {
    const previewUrl = `${this.previewBaseUrl}/api/coding/projects/${basename(this.sandboxRoot!)}/serve/${entryFile}`;
    const gotoResult = await this.agent.executor.execute("browser", {
      action: "goto",
      url: previewUrl,
      waitUntil: "networkidle2",
      timeout: 10000,
    });
    if (!gotoResult.success) {
      return { success: false, data: null, error: `Browser could not load ${entryFile}: ${gotoResult.error ?? "unknown error"}` };
    }

    const errorsResult = await this.agent.executor.execute("browser", { action: "get_page_errors" });
    if (!errorsResult.success) {
      return { success: false, data: null, error: `Browser check could not read page errors: ${errorsResult.error ?? "unknown error"}` };
    }

    const data = errorsResult.data as {
      pageErrors?: Array<{ type: string; text: string; url: string }>;
      networkErrors?: Array<{ url: string; error: string }>;
    };
    const pageErrors = data.pageErrors ?? [];
    const networkErrors = data.networkErrors ?? [];

    if (pageErrors.length === 0) {
      return {
        success: true,
        data: { entryFile, networkErrorCount: networkErrors.length },
      };
    }

    const detail = pageErrors
      .slice(0, 10)
      .map((e) => `[${e.type}] ${e.text} (${e.url})`)
      .join("\n");
    return {
      success: false,
      data: null,
      error: `${pageErrors.length} console/page error(s) after loading ${entryFile} in the browser:\n${detail}`,
    };
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
    this.currentPlanDb = undefined;
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
    // How many consecutive attempts may fail verification with the EXACT SAME error before the
    // run gives up as non-converging (see the identicalFailureStreak check below). Settings key:
    // AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES. Default 3 preserves the previous hardcoded behavior.
    const rawIdenticalVerifyLimit = parseInt((await this.db.getSetting("AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES")) ?? "", 10);
    const maxIdenticalVerifyFailures = Number.isFinite(rawIdenticalVerifyLimit)
      ? Math.min(20, Math.max(1, rawIdenticalVerifyLimit))
      : 3;

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
    this.currentPlanRunContext = opts.planRunContext;

    // Controller-owned completion evidence. Model prose and todo status are not execution
    // evidence; only checkpoint diffs (and the bounded parted-write healer) update these facts.
    // mutationExpected itself is assigned further down, once `plan` exists (see there for why) -
    // this closure only READS it, and isn't called until well after that assignment runs.
    let fileChangesObserved = false;
    const changedFiles = new Set<string>();

    const enforceCompletionContract = (candidate: CodingRunResult): CodingRunResult => {
      const openChecklistItems = this.todos
        .snapshot()
        .filter((item) => item.status === "pending" || item.status === "in_progress")
        .map((item) => item.title);
      const completionEvidence = {
        mutationExpected,
        fileChangesObserved,
        changedFiles: [...changedFiles].sort(),
        openChecklistItems,
      };

      let result = candidate;
      if (candidate.success && mutationExpected && !fileChangesObserved) {
        const reason =
          "this coding run required a project mutation, but no checkpoint diff recorded a file change; prose and checklist claims are not execution evidence";
        this.emit("decision", "Abschluss abgelehnt: keine belegte Dateiänderung.", {
          completion_contract: "mutation_missing",
        });
        result = {
          ...candidate,
          success: false,
          summary: `${candidate.summary}\n\n[Incomplete: ${reason}.]`,
        };
      } else if (candidate.success && openChecklistItems.length > 0) {
        const reason = `${openChecklistItems.length} required checklist step(s) remain open: ${openChecklistItems.join(", ")}`;
        this.emit("decision", "Abschluss abgelehnt: Pflichtschritte sind noch offen.", {
          completion_contract: "checklist_open",
          openItems: openChecklistItems,
        });
        result = {
          ...candidate,
          success: false,
          summary: `${candidate.summary}\n\n[Incomplete: ${reason}.]`,
        };
      }

      return {
        ...result,
        completionStatus: result.success
          ? result.verified
            ? "completed_verified"
            : "completed_unverified"
          : candidate.success
            ? "incomplete"
            : "failed",
        completionEvidence,
      };
    };

    // End-of-run guard: if a parted write (totalParts/partNumber) was started during this run
    // but not all parts arrived, the run must NOT end silently - the file(s) on disk are
    // incomplete, and that is exactly the "looks finished but parts are missing" failure the
    // part protocol exists to surface. Instead of merely warning, a bounded targeted follow-up
    // attempt writes exactly the missing parts (see healIncompleteSequences); the warning is
    // the fallback when healing does not finish the job. Every return path below goes through
    // this wrapper.
    const finalize = async (result: CodingRunResult): Promise<CodingRunResult> => {
      const incomplete = listIncompletePartSequences(this.sandboxFilter());
      if (incomplete.length === 0) return enforceCompletionContract(result);

      // After an explicit Stop, auto-starting more LLM calls would be surprising - warn only.
      const stopped = (this.agent as unknown as { stopRequested: boolean }).stopRequested === true;
      const healDetail = stopped ? null : await this.healIncompleteSequences(incomplete, conversationId);

      const stillIncomplete = listIncompletePartSequences(this.sandboxFilter());
      if (stillIncomplete.length === 0) {
        fileChangesObserved = true;
        for (const item of incomplete) changedFiles.add(item.path);
        this.emit("decision", "Self-Healing: fehlende Datei-Teile nachgeschrieben.", {
          part_healed: true,
          files: incomplete,
        });
        return enforceCompletionContract({
          ...result,
          summary:
            `${result.summary}\n\n[Self-Healing: die fehlenden Datei-Teile wurden automatisch ` +
            `nachgeschrieben.${healDetail ? ` ${healDetail}` : ""}]`,
        });
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
      return enforceCompletionContract({
        ...result,
        success: false,
        summary: `${result.summary}\n\nWARNUNG: ${warning}`,
      });
    };

    const detectedSkill = this.autoSelectCodingSkill(goal);
    let verifyCommand = opts.verifyCommand;
    // Set together with verifyCommand the first time the browser-check fallback fires (see the
    // attempt loop below) and never reset per-attempt - verifyCommand itself persists across
    // attempts once detected, so this flag must too. It used to be re-declared fresh inside each
    // attempt iteration, which meant attempt 2 correctly set BOTH verifyCommand and this flag,
    // but attempt 3+ saw verifyCommand already truthy, skipped re-detection entirely, and fell
    // through to the SHELL branch with a non-executable label as the "command" - producing
    // exactly "'browser' is not recognized as an internal or external command".
    let usingBrowserVerify = false;
    let staticEntryFile: string | undefined;

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
    // Fixed for the whole run (the shell-based checks above are project-structural facts that
    // don't change attempt to attempt). The static-HTML browser-check fallback below is NOT
    // decided here - unlike tsconfig.json/package.json, index.html often does not exist yet at
    // this point (the model writes it during attempt 1), so that check is re-evaluated fresh at
    // the top of every attempt instead, right before the verify step runs.

    // When resuming an existing conversation with a new goal (the user typed follow-up
    // instructions in the coding chat), the persisted plan from a previous run describes a
    // DIFFERENT task — reusing it would tell the agent to "create a landing page" when the
    // user just asked "add a contact form." Only rehydrate when there is genuinely NO new
    // goal (recover from crash/stop with the SAME conversation). A new goal always gets a
    // fresh plan; the old plan + checklist are still loaded below for hydration, but only
    // the checklist status (what was already done) carries over — not the plan steps.
    const persisted = isResuming && !opts.existingPlan ? await this.loadPersistedState(conversationId) : undefined;

    // Plan Mode's own bounded investigation: reads/browses/read-only-shells the project so the
    // Planner call below is grounded in what's actually there instead of only a bare file listing
    // (buildRepositorySnapshot). Model-driven, not mandatory - a trivial goal the model already
    // understands can just skip straight to a final answer with zero tool calls, exactly like the
    // normal EXPLORE phase already behaves. Bounded by PLAN_ONLY_EXPLORE_MAX_ITERATIONS via the
    // coding-plan-only-explore-lock hook, which also hard-blocks every mutating call for the
    // whole sub-run - no bypass, since "Plan Mode changed nothing" must hold regardless of what
    // the model tries.
    let explorationNotes: string | undefined;
    if (opts.planOnly && !opts.existingPlan) {
      this.emit("decision", "Plan-Modus: Recherche vor der Planerstellung.", { plan_only_explore: true });
      this.planOnlyExploreToolCalls = 0;
      this.planOnlyExploreActive = true;
      try {
        const exploreResult = await this.agent.run(
          `Goal to plan for: ${goal}\n\n` +
            "Before you plan, investigate the project as needed: read relevant files, browse the " +
            "running preview if useful, or run read-only shell inspection commands. You may call " +
            "zero tools if the goal is already clear. You CANNOT edit, write, install, build, run " +
            "tests, or make any git changes this turn - every such call will be refused. Stop as " +
            "soon as you have enough context and answer with a short, concrete summary of what you " +
            "found that is relevant to planning (existing structure, conventions, relevant files) - " +
            "do not propose the plan itself, that happens separately.",
          {
            ...(opts.onChunk ? { stream: true, onChunk: opts.onChunk } : {}),
            displayContent: `[Plan-Modus] Recherche fuer: ${goal}`,
          }
        );
        explorationNotes = exploreResult.response;
      } finally {
        this.planOnlyExploreActive = false;
      }
    }

    // Real planning subagent: a structured, detailed plan from the Planner instead of letting
    // the model invent one in free text during the PLAN phase (see buildInitialPrompt). A
    // caller-supplied plan (already reviewed/refined by the user, e.g. via the Plan panel) is
    // used as-is - re-deriving it here would throw away exactly the decision the caller made.
    // When resuming, we still call the Planner for the NEW goal — the old plan was for a
    // different task (or the same task's previous attempt, now stale).
    const toolNames = this.agent.executor.listTools().map((tool) => tool.name);
    // Selecting Coding Agent is itself an execution instruction. Do not let the shared planner
    // downgrade that explicit context into a general/research plan: such a plan can write a
    // Markdown research artifact, create a real checkpoint diff, and then make this run look
    // successful without ever implementing the requested software.
    const repositoryContext = { ...this.buildRepositorySnapshot(), ...(explorationNotes ? { explorationNotes } : {}) };
    const plan = opts.existingPlan ?? (await this.planner.createPlan(goal, toolNames, {
      requiredPlanType: "coding",
      repositoryContext,
    }));
    this.currentPlan = plan;
    // CodingAgent is an execution surface, so mutation is the safe default - but a plan whose
    // steps are ENTIRELY check/diagnostic work (see CHECKLIST_CHECK_KEYWORDS: explore, inspect,
    // read, diagnose, ...) never intended to change a file in the first place. Without this, a
    // pure analysis/debugging goal ran to a correct conclusion and was still marked incomplete
    // at the very end ("no checkpoint diff recorded a file change") purely because nothing
    // needed changing - which then fed back into the model's next-attempt prompt as failure
    // feedback it had no way to satisfy, and observably led it to give up and mark its own
    // checklist steps "blocked" even though every step's actual work was already done correctly.
    // Same classifier the per-step grounding check below already uses, just aggregated: if ANY
    // step looks like real construction work (or its title is unrecognized - default stays
    // strict), the whole run still requires evidence. Deliberately read-only review callers
    // (opts.mutationExpected explicitly set) and Plan Mode (opts.planOnly) still win outright.
    const mutationExpected = opts.mutationExpected ?? (opts.planOnly ? false : planRequiresMutation(plan));
    // A plan this call just created itself (not one the caller already had - opts.existingPlan
    // came with its own id from wherever it was loaded) is persisted to the `plans` table right
    // here, not only broadcast as an event. Without this row, the ONLY record of the plan was
    // the "plan" event message - and the coding chat's message list is paginated (most recent
    // 40), so a run with enough follow-up iterations pushes that one early event out of the
    // loaded window and the Plan tab goes blank mid-run even though the agent is still working
    // from it. GET /plans?conversationId=... lets the frontend look the plan up independently of
    // which page of messages happens to be loaded - see the id/version passed to emitPlanEvent
    // below. Best-effort: a failed write degrades the Plan tab, never the run itself.
    this.currentPlanDb = opts.existingPlan ? undefined : await this.persistPlan(plan, repositoryContext, conversationId);
    this.emitPlanEvent(plan, this.currentPlanDb);
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
      // A newly generated plan starts pending. A caller-supplied, versioned plan may contain
      // controller-owned completion state from an earlier run; preserve that so "run open
      // steps" does not redo verified work. Persisted conversation todos are still ignored,
      // because they may belong to a different goal.
      this.todos.replace(plan.steps.map((step) => ({
        title: step.title,
        ...(opts.existingPlan ? {
          status: step.status === "completed" ? "done" : step.status === "failed" ? "blocked" : step.status === "running" ? "in_progress" : "pending",
          ...(step.result ? { note: step.result } : {}),
        } : {}),
      })));
    } finally {
      this.suppressPlanSync = false;
    }

    if (opts.planOnly) {
      // Plan Mode: report the plan and stop here - the attempt loop below is exactly where
      // EXPLORE/EDIT/VERIFY (and every filesystem/shell tool call) happens, so never entering it
      // is what actually guarantees "nothing was executed", not a prompt instruction the model
      // could ignore.
      //
      // Deliberately bypasses finalize()/enforceCompletionContract(): the checklist is freshly
      // seeded as all-pending (nothing has executed yet, by design), and the open-checklist-items
      // check in enforceCompletionContract exists to catch a run that CLAIMED completion without
      // finishing its steps - a category error here, since this run never claimed to finish them.
      const stepList = plan.steps.map((step, i) => `${i + 1}. ${step.title}`).join("\n");
      this.emit("decision", "Plan-Modus: nur Plan erstellt, keine Ausfuehrung.", { plan_only: true });
      return {
        success: true,
        verified: false,
        completionStatus: "completed_unverified",
        summary: `Plan erstellt (${plan.steps.length} Schritt${plan.steps.length === 1 ? "" : "e"}), noch nicht ausgefuehrt:\n\n${stepList}`,
        attempts: 0,
        conversationId,
      };
    }

    const deadline = opts.timeoutMs && opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : undefined;

    let lastSummary = "";
    let nextAttemptReason: "verification_failed" | "checklist_open" | "guardrail" = "verification_failed";
    // A model may narrate the same next step forever without calling a tool. One retry is useful
    // for EXPLORE -> EDIT; repeating the identical ungrounded transition is a stall, not progress.
    const retriedUngroundedAnnouncements = new Set<number>();
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
          ? this.buildInitialPrompt(goal, verifyCommand, detectedSkill, plan, isResuming, mutationExpected)
          : this.buildFollowUpPrompt(goal, lastSummary, nextAttemptReason, mutationExpected);
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
      // Length of the cumulative journal before this attempt runs - used below to slice out
      // only THIS attempt's entries (journal is seeded from the previous attempt's tail via
      // initialRunJournal and keeps growing), so per-step attribution via stepId isn't
      // contaminated by writes an earlier attempt made against a step that just happened to
      // still be "current" at the start of this one.
      const journalLengthBeforeAttempt = journal.length;
      let runResult: AgentRunResult;
      try {
        runResult = await this.agent.run(prompt, {
          initialRunJournal: journal,
          getCurrentStepId: () => this.todos.currentStepId(),
          onModelResponse: (response) => this.updatePhaseFromResponse(response),
          ...(remainingMs && remainingMs > 0 ? { timeoutMsOverride: remainingMs } : {}),
          // CodingAgent never opted into this before - every run always used the blocking
          // generate() path, so the UI had nothing to show for the iteration currently in
          // flight (just the "thinking" indicator) until it fully finished. Agent.run() still
          // only forwards a whole iteration's cleaned text as one chunk (not per-token - partial
          // [TOOL:...] marker syntax can't safely be shown mid-generation), same as the regular
          // chat, but that is still a real live-ness improvement over emitting nothing at all.
          ...(opts.onChunk ? { stream: true, onChunk: opts.onChunk } : {}),
          // `prompt` is the full machine-facing scaffold (path rules, phase contract, plan,
          // ...) built above - only `goal` (what the caller actually asked for) belongs in the
          // conversation transcript. Same for every retry attempt: they all re-prompt for the
          // same goal, so the transcript should keep showing that goal, not the internal
          // "diagnose and fix" retry instructions.
          displayContent: goal,
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
      // Checkpoints are the strongest evidence, but they are intentionally best-effort (git
      // may be unavailable). Preserve a narrower fallback from successful filesystem journal
      // entries so a real write is not reported as a no-op merely because checkpoint setup
      // failed. Shell commands are deliberately excluded: their text does not prove a file was
      // persisted, even when the command itself exited successfully.
      for (const entry of journal) {
        if (
          entry.success &&
          entry.toolName === "filesystem" &&
          /^(write|append|edit|edit_lines|delete|move|copy)\b/i.test(entry.summary)
        ) {
          fileChangesObserved = true;
          const path = entry.summary.replace(/^\S+\s+/, "").trim();
          if (path) changedFiles.add(path);
        }
      }
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
        nextAttemptReason = "guardrail";
        continue;
      }

      // Ground the checklist against what the shadow-git checkpoint actually recorded: the
      // model is instructed never to mark a step "done" on the strength of an edit alone (see
      // buildInitialPrompt), but nothing enforced that until now - a model can call
      // todo:update(done) without having written anything. The checkpoint diff is the one
      // signal in this loop that reflects the real working tree rather than the model's own
      // account of it, so a "done" step with zero changed files is demoted back to in_progress
      // instead of being trusted at face value. Checked on EVERY attempt, not just before the
      // first real edit: a step that legitimately needs no file change (VERIFY/REPORT, or a
      // diagnostic step like "reproduce the error") is exempted by title via
      // CHECKLIST_CHECK_KEYWORDS instead of by "has any edit happened yet in this run" - the
      // previous run-wide gate stopped checking entirely after the first edit, so a construction
      // step falsely marked "done" with zero changes in attempt 3+ went completely undetected.
      let attemptChangedFileCount = 0;
      // Set when this attempt's own "done" claim got demoted below - a real signal that the
      // model IS actively driving the checklist (just prematurely), distinct from
      // anyFileChangedThisRun's "never touched the checklist tool at all" scenario. Used below
      // to justify one more attempt even when no file changed yet - a legitimate diagnostic step
      // (e.g. "reproduce the error" via the browser tool) can be genuinely complete without
      // editing a single file, so gating solely on a file diff wrongly ends runs like that one.
      let groundingDemotedThisAttempt = false;
      if (this.sandboxRoot && checkpoint) {
        const attemptDiff = await diffCheckpoint(this.sandboxRoot, checkpoint.sha);
        const changedFileCount = attemptDiff?.files.length ?? 0;
        attemptChangedFileCount = changedFileCount;
        if (changedFileCount > 0) {
          anyFileChangedThisRun = true;
          fileChangesObserved = true;
          for (const file of attemptDiff?.files ?? []) changedFiles.add(file.path);
        }
        if (mutationExpected) {
          // This attempt's own journal slice, and which todo step was "current" (per
          // getCurrentStepId) at the moment each successful filesystem write happened. This is
          // the one signal precise enough to attribute a write to a SPECIFIC step rather than
          // just to the attempt as a whole - needed because changedFileCount>0 alone cannot
          // tell "step A's write" apart from "an unrelated step B's write", which previously let
          // a step be confirmed "done" purely because *some other* step touched a file in the
          // same attempt (see coding-agent-checklist-grounding memory: batch-update gap).
          const thisAttemptJournal =
            journal.length >= journalLengthBeforeAttempt ? journal.slice(journalLengthBeforeAttempt) : journal;
          const stepIdsWithConfirmedWrite = new Set<string>();
          let anyStepIdTrackedThisAttempt = false;
          for (const entry of thisAttemptJournal) {
            if (entry.stepId) anyStepIdTrackedThisAttempt = true;
            if (
              entry.success &&
              entry.stepId &&
              entry.toolName === "filesystem" &&
              /^(write|append|edit|edit_lines|delete|move|copy)\b/i.test(entry.summary)
            ) {
              stepIdsWithConfirmedWrite.add(entry.stepId);
            }
          }
          const newlyDone = this.todos
            .snapshot()
            .filter((item) => {
              if (item.status !== "done") return false;
              if (todosBeforeAttempt.find((before) => before.id === item.id)?.status === "done") return false;
              // Construction verbs take precedence over check verbs so a mixed title like "fix
              // the bug and verify" is still held to the file-change requirement. A pure
              // check/read/verify step (no toolcalls, or read-only ones) is legitimately done
              // without ever writing a file - exempted here, unaffected by everything below.
              if (CHECKLIST_CONSTRUCTION_KEYWORDS.test(item.title)) return true;
              if (CHECKLIST_CHECK_KEYWORDS.test(item.title)) return false;
              return true; // unrecognized title: default to requiring evidence, same as before.
            })
            .filter((item) => {
              // Confirmed by its OWN write this attempt - the strong, per-step signal. stepId on
              // the journal entry is always a string (RunJournalEntry.stepId), while todo item
              // ids are numbers - compare as strings so "1" matches 1.
              if (stepIdsWithConfirmedWrite.has(String(item.id))) return false;
              // No step-attributed write exists anywhere in this attempt's journal at all
              // (getCurrentStepId wasn't wired, or nothing ran through it) - fall back to the
              // coarse, attempt-wide checkpoint diff rather than demoting on missing
              // instrumentation alone.
              if (!anyStepIdTrackedThisAttempt) return changedFileCount === 0;
              // stepId WAS tracked this attempt, just never for this step: some other step's
              // write cannot vouch for this one.
              return true;
            });
          groundingDemotedThisAttempt = newlyDone.length > 0;
          if (newlyDone.length > 0) {
            for (const item of newlyDone) {
              this.todos.update(
                item.id,
                "in_progress",
                'Als "done" gemeldet, aber weder der Checkpoint-Diff noch das Journal dieses Versuchs zeigen eine diesem Schritt zuordenbare Dateiänderung - zurückgestuft.'
              );
            }
            this.emit(
              "decision",
              `Checkliste behauptete ${newlyDone.length} erledigte(n) Schritt(e) in Versuch ${attempt}, ohne diesem Schritt zuordenbare Dateiänderung - zurückgestuft auf "in_progress".`,
              { attempt, items: newlyDone.map((item) => item.title) }
            );
            lastSummary = `${lastSummary}\n\n[Checklist grounding: ${newlyDone.length} step(s) marked "done" were reset to "in_progress" - neither the checkpoint diff nor this attempt's journal show a file change attributable to that specific step, so the completion claim could not be confirmed: ${newlyDone.map((item) => item.title).join(", ")}]`;
          }
        }
      }

      // Small/local models frequently narrate a correct transition ("Step 2: ...") after
      // completing step 1 but omit the todo:update call. Reconcile that explicit transition
      // only when this attempt has a real checkpoint diff: prose alone is never enough. This
      // prevents the outer decision loop from treating already-finished predecessors as open.
      const announcedWorkStep = this.findAnnouncedWorkStep(lastSummary);
      this.reconcileAnnouncedStep(lastSummary, attemptChangedFileCount);

      // Re-checked fresh every attempt UNTIL it fires once (not just once before the loop): a
      // static HTML/CSS/JS project's index.html typically does not exist yet on attempt 1 - it
      // is the model's FIRST edit - so detecting it before the loop starts would always miss it.
      // Once usingBrowserVerify is true, both it and verifyCommand are left alone for the rest
      // of the run (re-detecting would be redundant, and re-running this block after
      // verifyCommand is already the browser-check label would break the `!verifyCommand` guard
      // below the same way the bug this fixes did). See detectStaticEntryFile()/
      // runBrowserVerify() for why this exists at all.
      if (!verifyCommand) {
        staticEntryFile = this.detectStaticEntryFile();
        if (staticEntryFile && this.agent.executor.listTools().some((tool) => tool.name === "browser")) {
          verifyCommand = `browser check: ${staticEntryFile} (console/page errors)`;
          usingBrowserVerify = true;
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
        // "Step N: <work>" is an explicit continuation signal even before the first edit.
        // That is the normal EXPLORE -> EDIT transition, so requiring a file diff here would
        // incorrectly finalize precisely when the model announces the work it will do next.
        const hasGroundedOpenWork = openItems.length > 0 && (anyFileChangedThisRun || groundingDemotedThisAttempt);
        const hasExplicitContinuation = announcedWorkStep !== undefined && (
          attemptChangedFileCount > 0 || !retriedUngroundedAnnouncements.has(announcedWorkStep)
        );
        if ((hasGroundedOpenWork || hasExplicitContinuation) && attempt < maxAttempts) {
          if (hasExplicitContinuation && announcedWorkStep !== undefined && attemptChangedFileCount === 0) {
            retriedUngroundedAnnouncements.add(announcedWorkStep);
          }
          this.emit(
            "decision",
            hasExplicitContinuation
              ? `Keine Verifikation moeglich, aber Schritt ${announcedWorkStep} wurde als naechste Arbeit angekuendigt - fordere Fortsetzung an.`
              : groundingDemotedThisAttempt
                ? `Keine Verifikation moeglich, und die eben zurueckgestufte Checkliste zeigt noch ${openItems.length} offene(n) Schritt(e) - fordere Fortsetzung an.`
                : `Keine Verifikation moeglich, aber ${openItems.length} Checklisten-Schritt(e) noch offen - fordere Fortsetzung an.`,
            { attempt, announcedWorkStep, openItems: openItems.map((item) => item.title) }
          );
          lastSummary =
            `${lastSummary}\n\nNo verification command exists for this project, but your own checklist still has ` +
            `open step(s): ${openItems.map((item) => item.title).join(", ") || `the explicitly announced step ${announcedWorkStep}`}. Finish them - in particular VERIFY ` +
            `(if you have NOT already read the file(s) you wrote in this attempt, read them ONCE now, or run/open ` +
            `them via the shell or browser tool if possible; if you already read them, do NOT read them again - ` +
            `just judge what you already saw) and REPORT (summarize what changed and what you checked) - then STOP. ` +
            `State a clear PASS/FAIL conclusion in words; do not repeat any check you already performed this attempt.`;
          nextAttemptReason = "checklist_open";
          continue;
        }
        // Nothing to check against - report honestly that the result is unverified
        // instead of letting "no check" masquerade as a passing check.
        this.emit("decision", "Keine Verifikation moeglich - Ergebnis ist ungeprueft.", { attempt });
        return finalize({ success: true, verified: false, summary: lastSummary, attempts: attempt, conversationId });
      }

      const verifyResult = usingBrowserVerify
        ? await this.runBrowserVerify(staticEntryFile!)
        : await this.agent.executor.execute("shell", {
            command: verifyCommand,
            // Without an explicit cwd the shell tool falls back to the server process's own
            // directory, so a sandboxed run would verify the wrong project entirely.
            ...(this.sandboxRoot ? { cwd: this.sandboxRoot } : {}),
          });
      if (verifyResult.success) {
        this.emit("decision", `Verifikation "${verifyCommand}" erfolgreich.`, { attempt, verifyCommand });
        this.reconcileFinalStepAfterVerification(lastSummary);
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

      // Compared with line/column numbers blanked out: a genuinely non-converging edit (e.g. one
      // that adds an unrelated line above the broken one, or renames a nearby symbol) shifts
      // every subsequent line number without changing the error itself, which used to reset
      // identicalFailureStreak to 0 on every attempt and let the run burn its whole budget on a
      // failure this check exists specifically to catch early.
      const isIdenticalToPreviousFailure =
        previousVerifyError !== undefined &&
        normalizeVerifyErrorForComparison(verifyError) === normalizeVerifyErrorForComparison(previousVerifyError);
      identicalFailureStreak = isIdenticalToPreviousFailure ? identicalFailureStreak + 1 : 0;
      previousVerifyError = verifyError;

      if (identicalFailureStreak >= maxIdenticalVerifyFailures - 1) {
        // maxIdenticalVerifyFailures attempts in a row produced the exact same verify error: the
        // model's edits are provably not changing the outcome. Burning the rest of maxAttempts
        // would just repeat this - stop now with a clear, honest diagnosis instead of a generic
        // "failed" summary.
        this.emit(
          "decision",
          `Abgebrochen: ${maxIdenticalVerifyFailures} Versuche in Folge mit identischem Verifikationsfehler - keine Konvergenz erkennbar.`,
          { attempt, verifyCommand }
        );
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
      nextAttemptReason = "verification_failed";

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

  /** Returns the last explicit current-work transition ("Step N: ..."), if present. */
  private findAnnouncedWorkStep(response: string): number | undefined {
    const matches = [...response.matchAll(/\b(?:step|schritt)\s*(\d+)\s*[:.\-]\s*\S/gi)];
    const announced = Number(matches[matches.length - 1]?.[1]);
    return Number.isInteger(announced) && announced > 0 ? announced : undefined;
  }

  /**
   * Reconciles an explicit model transition such as "Step 2: Create BootScene" with the
   * structured checklist. This is deliberately conservative: it requires a real file diff in
   * the same attempt and only closes predecessors of the announced step. It never infers
   * completion from generic prose such as "done" and never closes the announced/current step.
   */
  private reconcileAnnouncedStep(response: string, changedFileCount: number): void {
    if (changedFileCount <= 0) return;
    const announcedNumber = this.findAnnouncedWorkStep(response);
    if (announcedNumber === undefined) return;
    const items = this.todos.snapshot();
    if (!Number.isInteger(announcedNumber) || announcedNumber < 2 || announcedNumber > items.length) return;

    const predecessorIndex = announcedNumber - 2;
    const announcedIndex = announcedNumber - 1;
    const predecessor = items[predecessorIndex];
    const announced = items[announcedIndex];
    if (!predecessor || !announced || items.slice(0, announcedIndex).some((item) => item.status === "blocked")) return;

    let changed = false;
    // A transition to step N is evidence only for the contiguous predecessor. Earlier steps are
    // closed as well when still open because a sequential numbered transition necessarily passed
    // them; blocked steps stop reconciliation above rather than being silently overridden.
    for (let index = 0; index <= predecessorIndex; index++) {
      const item = items[index];
      if (item && item.status !== "done" && item.status !== "blocked") {
        this.todos.update(item.id, "done", `Automatisch konsolidiert: Modell wechselte nach Dateiänderung zu Schritt ${announcedNumber}.`);
        changed = true;
      }
    }
    if (announced.status === "pending") {
      this.todos.update(announced.id, "in_progress", `Vom Modell als aktueller Schritt ${announcedNumber} angekündigt.`);
      changed = true;
    }
    if (changed) {
      this.emit("decision", `Fortschritt mit Checkliste konsolidiert: Schritt ${announcedNumber - 1} abgeschlossen, Schritt ${announcedNumber} aktiv.`, {
        announcedStep: announcedNumber,
        changedFileCount,
        todo_items: this.todos.snapshot(),
      });
    }
  }

  /**
   * A numbered transition can close step N only when the model moves on to N+1. The final step
   * has no successor, so a run that finishes with "Step 5 ... READY FOR DEPLOYMENT" used to
   * return verified:true while leaving that row in_progress forever. Close only the sole open,
   * final item, only after the outer verification gate passed, and only when the response names
   * that exact step with an explicit terminal status. This avoids treating generic "done" prose
   * as checklist evidence or hiding an earlier unfinished/blocked step.
   */
  private reconcileFinalStepAfterVerification(response: string): void {
    const items = this.todos.snapshot();
    if (items.length === 0 || items.some((item) => item.status === "blocked")) return;

    const open = items.filter((item) => item.status === "pending" || item.status === "in_progress");
    const finalItem = items[items.length - 1];
    if (open.length !== 1 || !finalItem || open[0]?.id !== finalItem.id) return;
    if (items.slice(0, -1).some((item) => item.status !== "done")) return;

    const finalStepNumber = items.length;
    const explicitTerminalLine = response.split(/\r?\n/).some((line) => {
      const namesFinalStep = new RegExp(`\\b(?:step|schritt)\\s*${finalStepNumber}\\s*[:.\\-]`, "i").test(line);
      if (!namesFinalStep || /\b(?:not|nicht)\s+(?:complete|completed|done|verified|fertig|abgeschlossen|verifiziert)\b/i.test(line)) {
        return false;
      }
      return /\b(?:completed?|done|verified|ready\s+for\s+deployment|fertig|abgeschlossen|verifiziert|einsatzbereit)\b/i.test(line);
    });
    if (!explicitTerminalLine) return;

    this.todos.update(
      finalItem.id,
      "done",
      `Automatisch abgeschlossen: Schritt ${finalStepNumber} wurde explizit als fertig gemeldet und die Verifikation war erfolgreich.`
    );
    this.emit("decision", `Finalen Checklisten-Schritt ${finalStepNumber} nach erfolgreicher Verifikation abgeschlossen.`, {
      finalStep: finalStepNumber,
      todo_items: this.todos.snapshot(),
    });
  }

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
   * Runs for structural rewrites and ordinary status ticks so the Plan panel and checklist use
   * one state. The initial plan seed is guarded by suppressPlanSync to avoid duplicate events.
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
    this.emitPlanEvent(this.currentPlan, this.currentPlanDb);
    // Keeps the persisted plans-table row's step statuses live too, not just the freshly-created
    // shape from persistPlan() - otherwise GET /plans?conversationId=... (the Plan tab's fallback
    // once the live "plan"/"decision" events fall out of its paginated message window - see
    // CodingPlanPanel's latestPersistedPlan) would keep answering with the ORIGINAL all-pending
    // steps forever, showing the plan but resetting its progress. Fire-and-forget: this handler
    // runs synchronously off TodoList's onChange, and a lost status update here degrades the
    // Plan tab's resilience, never the run itself - the live event path (just emitted above)
    // remains the primary, faster source whenever its message is still in the loaded window.
    if (this.currentPlanDb) {
      const dbId = this.currentPlanDb.id;
      void this.db.updatePlan(dbId, { steps: JSON.stringify(steps) }).catch((error) => {
        this.logger.warn("Failed to sync plan step statuses to the plans table", {
          planId: dbId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
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
    const contextualData = this.currentPlanRunContext ? { ...(data ?? {}), ...this.currentPlanRunContext } : data;
    const toolResult = JSON.stringify({ eventType, data: contextualData, timestamp });
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

  /**
   * Writes a freshly-created Plan into the `plans` table (the same table/shape the `/plans`
   * REST routes and the Plan panel's version history already use), so it is discoverable by
   * GET /plans?conversationId=... independent of the coding chat's paginated message window -
   * see emitPlanEvent's doc comment for why that matters. version is always 1: CodingAgent
   * itself never revises a plan in place (that only happens via POST /plans/refine, which
   * already persists its own row), so every plan this creates is the first version of a new
   * plan lineage. Swallows write failures - a missing row degrades the Plan tab, never the run.
   */
  private async persistPlan(
    plan: Plan,
    repositoryContext: Record<string, unknown> | undefined,
    conversationId: number
  ): Promise<{ id: number; version: number } | undefined> {
    try {
      const row = await this.db.createPlan({
        conversationId,
        projectId: null,
        goal: plan.goal,
        title: plan.goal.slice(0, 200),
        complexity: plan.estimatedComplexity === "high" ? 5 : plan.estimatedComplexity === "medium" ? 3 : 1,
        steps: JSON.stringify(plan.steps),
        tools: JSON.stringify([...new Set(plan.steps.flatMap((step) => step.toolsNeeded ?? []))]),
        markdown: formatPlanAsMarkdown(plan),
        status: "draft",
        version: 1,
        parentPlanId: null,
        repositorySnapshot: repositoryContext ? JSON.stringify(repositoryContext) : null,
      });
      return { id: row.id, version: row.version };
    } catch (error) {
      this.logger.warn("Failed to persist plan to the plans table", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /** Emits the Planner's structured plan as a "plan" event, the same payload shape agent.ts's
   *  plan mode uses - CodingPlanPanel filters only on eventType==="plan" with goal+steps, not on
   *  `source`, so this is picked up without any UI change.
   *
   *  @param dbPlan The `plans` table row this Plan was just persisted as (see run() - every
   *    freshly-created plan is written to the DB before this is called). Its id/version ride
   *    along in the event payload so the frontend can look the SAME plan up independently via
   *    GET /plans?conversationId=... - which does not depend on this event still being inside
   *    the client's currently-loaded (paginated) message window. Undefined only for a
   *    caller-supplied opts.existingPlan, which already has an id from wherever it came from. */
  private emitPlanEvent(plan: Plan, dbPlan?: { id: number; version: number }): void {
    const payload = toPlanEventPayload(plan, formatPlanAsMarkdown(plan));
    // __rawPlan carries the exact internal Plan object (dependsOn/riskLevel/toolsNeeded, the
    // step id scheme, everything) alongside the UI-shaped payload above - so a later run() on
    // the same conversation can rehydrate the EXACT plan it already had (see loadPersistedState)
    // instead of reconstructing an approximation from the flattened UI fields, or re-planning
    // from scratch and losing whatever the user already saw progress on. The UI ignores the
    // extra field; it never had a reason to look for it.
    const data = {
      ...payload,
      source: "coding_agent",
      __rawPlan: plan,
      ...(dbPlan ? { id: dbPlan.id, version: dbPlan.version } : {}),
    };
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
    const lines = [
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
      "YOUR OWN PLANNING / STATUS NOTES:",
      "- If you keep a status file, progress log, or planning note FOR YOURSELF (not something the",
      "  user asked you to build), it belongs under 'plans/' (e.g. 'plans/STATUS.md') - never at the",
      "  project root and never under a name you invent fresh each run.",
      "- Before writing one, list 'plans/' first. If a status/plan file already exists there, UPDATE",
      "  that file - do not create a second one with a different name. You will not remember this run",
      "  on the next one; the file is the only memory of it, so there must only ever be one.",
      "- Only write one at all if it actually serves a purpose (a genuinely multi-attempt or",
      "  multi-session task). A short, single-pass fix does not need a status file - do not create",
      "  one out of habit.",
      "",
    ];
    if (this.previewBaseUrl) {
      const previewUrl = `${this.previewBaseUrl}/api/coding/projects/${basename(this.sandboxRoot)}/serve/index.html`;
      lines.push(
        "BROWSER PREVIEW / TESTING:",
        `- To look at or test this project in the browser tool, navigate to: ${previewUrl}`,
        `- NEVER use a 'file://' URL for this project - it looks like it works, but Chromium blocks`,
        `  ES module scripts and fetch() under file:, so the page silently fails in ways that look`,
        `  like a real bug. The URL above is a real HTTP server and serves the project correctly.`,
        `- Do NOT pass newSession/sessionId - omitting both reuses the one shared browser session`,
        `  (the same one the user may already have open), instead of opening a second, separate one.`,
        `- Use browser snapshot before clicking. Prefer role/name targeting over coordinate guesses;`,
        `  snapshots include rendered off-screen controls and Puppeteer will scroll them into view.`,
        `- After click/type/scroll, read a fresh snapshot or use expect/get_content before deciding`,
        `  what happened. Never infer success from an old screenshot or from the click result alone.`,
        `- If you add a favicon, link it with a RELATIVE href (e.g. <link rel="icon" href="favicon.ico">),`,
        `  never a leading-slash absolute path ('/favicon.ico'). The project is served under a`,
        `  per-project path, not the site root - an absolute href (and the browser's own automatic`,
        `  '/favicon.ico' probe when no <link> exists at all) resolves against the site root and 404s`,
        `  even when the file exists in this project, exactly like './app.js' would if it were absolute.`,
        "",
      );
    }
    return lines;
  }

  private buildInitialPrompt(
    goal: string,
    verifyCommand: string | undefined,
    detectedSkill: string | undefined,
    plan: Plan,
    isResuming: boolean,
    mutationExpected: boolean
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
      "EXECUTION CONTRACT:",
      ...(mutationExpected
        ? [
            "- This is a coding execution run. Describing or announcing a write does not change the project.",
            "- At least one real filesystem mutation must be recorded before the controller can accept success.",
          ]
        : ["- This is an explicitly read-only coding review; do not mutate project files."]),
      "- A final answer while required checklist steps are still open is rejected as incomplete.",
      "- When you know the next action, emit its tool call immediately; do not spend a turn promising it.",
      "",
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

  private buildFollowUpPrompt(
    goal: string,
    previousSummaryWithVerification: string,
    reason: "verification_failed" | "checklist_open" | "guardrail",
    mutationExpected: boolean
  ): string {
    // The checklist carries across attempts. Each attempt is a fresh agent.run(), so without
    // replaying it here the agent would re-plan from scratch and redo steps it already finished.
    const checklist = this.todos.render();
    const opening = reason === "verification_failed"
      ? "Your previous attempt failed its verification command. Diagnose the ACTUAL failure below and fix it - do not repeat the same approach blindly."
      : reason === "guardrail"
        ? "Your previous attempt was stopped by a loop guardrail. Continue from structured state without repeating the blocked action."
        : "The previous attempt made progress but ended while structured checklist steps were still open. Continue with the first open step; do not redo completed steps.";
    return [
      opening,
      "",
      mutationExpected
        ? "The controller will reject success unless a real filesystem mutation is recorded and every required checklist step is closed. Prose claims do not count. Call the next tool immediately instead of announcing it."
        : "This run is explicitly read-only. The controller still requires every checklist step to be closed; prose claims do not count as evidence.",
      "",
      "BEFORE YOU ACT, call the status tool. It tells you in one call what normally takes several reads: which steps are already done (from the checklist), what files you actually changed (from the checkpoint diff - not your memory), and whether any diagnostics are still failing. Your conversation context may have been trimmed and earlier results may no longer be visible, so do NOT rely on what you remember - ask the status tool for ground truth.",
      this.pathHandlingBlock().join("\n"),
      `Original goal: ${goal}`,
      checklist ? `Your checklist so far (keep updating it, do not start it over):\n${checklist}` : "",
      reason === "verification_failed" ? "Previous attempt summary and verification output:" : "Continuation context:",
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
