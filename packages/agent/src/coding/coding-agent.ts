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
import { TodoList, createTodoTool } from "./todo-tool.js";
import { createCheckpoint, discardNoopCheckpoint } from "./checkpoints.js";
import { withPerEditCheckpoints } from "./checkpoint-on-write.js";
import { createExploreTool } from "./explore-tool.js";
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
  /** Read by withPerEditCheckpoints' label closure - kept as instance state because tools are
   *  registered ONCE in the constructor, before any attempt number exists yet. */
  private currentAttempt = 0;

  constructor(
    provider: LLMProvider,
    db: DatabaseService,
    eventEmitter?: AgentEventEmitter,
    options: CodingAgentOptions = {}
  ) {
    this.defaultMaxAttempts = Math.max(1, options.maxAttempts ?? 4);
    this.sandboxRoot = options.sandboxRoot;
    this.eventEmitter = eventEmitter;
    this.logger = getRootLogger().child(`CodingAgent:${options.name ?? "CodingAgent"}`);
    this.planner = new Planner(provider, this.logger);

    // Every checklist change is pushed straight to the UI, so what the user watches is the same
    // state the agent is steering by - not a second, prose-derived approximation of it.
    this.todos = new TodoList((items) => {
      this.emit("decision", "Checkliste aktualisiert", {
        todo_items: items,
        open: items.filter((item) => item.status === "pending" || item.status === "in_progress").length,
      });
    });

    const basePrompt = options.systemPrompt ?? `${CODING_DIRECTIVE}\n\n${TOOL_CALL_FORMAT_BLOCK}`;

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

    this.agent = new Agent(provider, db, eventEmitter, {
      name: options.name ?? "CodingAgent",
      systemPrompt: basePrompt,
      // 100 per attempt x 4 attempts allowed 400 LLM calls for a single goal. A coding turn
      // that has not converged in 40 tool-call iterations is not going to converge in 60 - it
      // is looping. The macro attempt loop (with its verify feedback) is the productive retry
      // path, not a longer inner loop.
      maxIterations: options.maxIterations ?? 40,
      hooks: disciplineHooks,
      // Code responses are long and slow to re-evaluate; the reflection/verify
      // passes repeatedly hit their timeout with a local model. Skip them here.
      disableQualityPasses: true,
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
    for (const tool of [fsTool, shTool, dxTool, gitTool, skillsTool, createTodoTool(this.todos), exploreTool, ...(options.extraTools ?? [])]) {
      this.agent.executor.registerTool(tool);
    }
  }

  /**
   * Scans a model response for its LATEST ">> PHASE: X" marker and updates currentPhase, which
   * the phase-lock hook (see the constructor) reads for every tool call in this same response.
   * Called via AgentRunOptions.onModelResponse, i.e. before this response's own tool calls are
   * validated - a response that says ">> PHASE: EDIT" and then immediately writes a file in the
   * same turn is exactly the intended flow, not a race.
   */
  private updatePhaseFromResponse(response: string): void {
    let lastMatch: RegExpExecArray | null = null;
    for (const match of response.matchAll(PHASE_MARKER_RE)) lastMatch = match;
    const declared = lastMatch?.[1]?.toLowerCase();
    if (declared === "explore" || declared === "plan" || declared === "edit" || declared === "verify" || declared === "report") {
      this.currentPhase = declared;
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
   * Best-effort default so "no verifyCommand" doesn't silently mean "no check
   * at all" - falls back to a project-detected typecheck/build, or undefined
   * if nothing detectable exists (never fabricates a command that would fail
   * for unrelated reasons).
   */
  private detectDefaultVerifyCommand(): string | undefined {
    if (!this.sandboxRoot) return undefined;
    if (existsSync(join(this.sandboxRoot, "tsconfig.json"))) {
      return "npx tsc --noEmit";
    }
    const packageJsonPath = join(this.sandboxRoot, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          scripts?: Record<string, string>;
        };
        if (pkg.scripts?.["build"]) return "npm run build";
      } catch {
        // malformed package.json - nothing detectable, fall through
      }
    }
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
    this.todos.reset();
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
    const conversationId =
      typeof reuseId === "number" && Number.isFinite(reuseId) && reuseId > 0
        ? (await this.agent.loadConversation(reuseId), reuseId)
        : await this.agent.startConversation({ name: `CodingAgent: ${goal.slice(0, 60)}` });
    opts.onConversationStarted?.(conversationId);

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

    if (!verifyCommand && detectedSkill) {
      if (detectedSkill === "test-driven-development") {
        verifyCommand = "npm test";
      } else if (detectedSkill === "code-review") {
        verifyCommand = "npm run lint";
      }
    }

    if (!verifyCommand) {
      verifyCommand = this.detectDefaultVerifyCommand();
    }

    // Real planning subagent: a structured, detailed plan from the Planner instead of letting
    // the model invent one in free text during the PLAN phase (see buildInitialPrompt). A
    // caller-supplied plan (already reviewed/refined by the user, e.g. via the Plan panel) is
    // used as-is - re-deriving it here would throw away exactly the decision the caller made.
    const toolNames = this.agent.executor.listTools().map((tool) => tool.name);
    const plan = opts.existingPlan ?? (await this.planner.createPlan(goal, toolNames));
    this.emitPlanEvent(plan);
    // Pre-seeds the checklist with the planner's steps so the UI shows real progress from the
    // very first tool call, instead of an empty list until the model gets around to calling
    // todo:write itself. Title-matched merge (see TodoList.replace) keeps these ids stable if
    // the model later calls todo:write again to adjust the plan post-exploration.
    this.todos.replace(plan.steps.map((step) => ({ title: step.title })));

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
          ? this.buildInitialPrompt(goal, verifyCommand, detectedSkill, plan)
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

      if (!verifyCommand) {
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
      (g) => `- ${g.path}: Teil ${g.received} von ${g.totalParts} geschrieben, Teil ${g.next} fehlt`
    );
    const prompt =
      `Einige Datei-Schreibsequenzen aus dem vorherigen Lauf sind unvollstaendig. Schreibe NUR die fehlenden Teile nach:\n\n` +
      lines.join("\n") +
      `\n\nRegeln:\n` +
      `1. Lese jede Datei kurz, um zu sehen, was bereits geschrieben wurde.\n` +
      `2. Schreibe NUR die fehlenden Teile mit action:append partNumber:<n> totalParts:<m> in der Block-Form - <n> und <m> sind exakt die oben genannten Werte. Die laufende Sequenz prueft die Reihenfolge und lehnt Luecken oder Duplikate ab.\n` +
      `3. Veraendere KEINE anderen Dateien, schreibe KEINE bereits geschriebenen Teile neu und wiederhole nichts.\n` +
      `4. Wenn eine Datei schon vollstaendig ist, lasse sie unveraendert.\n` +
      `5. Bestaetige am Ende kurz, welche Dateien du vervollstaendigt hast.`;

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
      return detail.length > 0 ? `Folge-Versuch: ${detail}` : "Folge-Versuch ausgefuehrt.";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("decision", "Self-Healing fehlgeschlagen - nur Warnung.", {
        part_heal_error: true,
        error: message.slice(0, 200),
      });
      return null;
    }
  }

  private emit(type: "iteration" | "decision" | "phase_started" | "phase_completed" | "phase_failed", message: string, data?: Record<string, unknown>): void {
    try {
      const eventType: "iteration" | "decision" | "internal_instruction" = type === "iteration" ? "iteration" : type === "decision" ? "decision" : "internal_instruction";
      this.eventEmitter?.emitEvent({ type: eventType, message, data, timestamp: new Date().toISOString() });
    } catch {
      // Event delivery is best-effort telemetry - never let it abort a coding run.
    }
  }

  /** Emits the Planner's structured plan as a "plan" event, the same payload shape agent.ts's
   *  plan mode uses - CodingPlanPanel filters only on eventType==="plan" with goal+steps, not on
   *  `source`, so this is picked up without any UI change. */
  private emitPlanEvent(plan: Plan): void {
    try {
      const payload = toPlanEventPayload(plan, formatPlanAsMarkdown(plan));
      this.eventEmitter?.emitEvent({
        type: "plan" as AgentRunEventType,
        message: `Plan: ${plan.goal}`,
        data: { ...payload, source: "coding_agent" },
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Event delivery is best-effort telemetry - never let it abort a coding run.
    }
  }

  private emitPhase(event: CodingPhaseEvent): void {
    try {
      const message = `${event.title}${event.description ? ': ' + event.description : ''}`;
      this.eventEmitter?.emitEvent({
        type: "internal_instruction" as const,
        message,
        data: {
          phase_event: event.type,
          phase: event.phase,
          title: event.title,
          description: event.description,
          result: event.result,
          error: event.error,
          attempt: event.attempt,
        },
        timestamp: event.timestamp,
      });
    } catch {
      // Event delivery is best-effort telemetry - never let it abort a coding run.
    }
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
    plan: Plan
  ): string {
    const parts: string[] = [`Goal: ${goal}`, "", ...this.pathHandlingBlock()];

    parts.push(
      "Track your progress with the todo tool: it already contains the plan below as pending steps.",
      "Mark a step in_progress before starting it and done once it is verified. That checklist is what",
      "the user sees, so keep it truthful - never mark a step done on the strength of an edit alone,",
      "only once diagnostics or the verification command confirmed it.",
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
