import type { LLMProvider } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import type { AgentEventEmitter, AgentRunOptions, AgentRunResult } from "../config/interfaces_types.js";
import { getRootLogger } from "@ducki/logger";
import {
  CodingAgent as BaseCodingAgent,
  condenseVerifyOutput,
  type CodingAgentOptions,
  type CodingRunOptions,
  type CodingRunResult,
} from "./coding-agent.js";
import { CodingRunState, type CodingFailureReflection } from "./coding-run-state.js";
import { CodingFailureReflector, type CodingFailureEditDiff } from "./failure-reflector.js";

const DEFAULT_MAX_IDENTICAL_VERIFY_FAILURES = 3;

function formatFailureReflection(reflection: CodingFailureReflection): string {
  const lines = [
    "## Failure reflection — change strategy, do not repeat the last fix",
    `Diagnosis: ${reflection.diagnosis}`,
  ];
  if (reflection.avoid.length > 0) {
    lines.push("Avoid:", ...reflection.avoid.map((item) => `- ${item}`));
  }
  if (reflection.nextActions.length > 0) {
    lines.push("Next actions:", ...reflection.nextActions.map((item) => `- ${item}`));
  }
  lines.push(
    "Treat this as a diagnostic hint, not ground truth. Verify it against the repository before editing."
  );
  return lines.join("\n");
}

/** Filesystem actions whose input carries the actual content the reflector needs to see. */
const EDIT_ACTIONS = new Set(["write", "edit", "append"]);

/**
 * Thin compatibility wrapper around the existing CodingAgent.
 *
 * It intentionally does not replace the macro plan/verify/checkpoint loop. Instead it observes the
 * two stable seams that already exist:
 *   1. each macro attempt calls the inner Agent.run();
 *   2. deterministic verification immediately follows through innerAgent.executor.execute("shell").
 *
 * When the SAME verifier failure occurs on consecutive attempts, we have objective evidence that
 * the previous edit did not affect the failure. Each such repeat (up to the point the base
 * CodingAgent gives up as non-converging - see AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES) gets
 * its own bounded reflection call diagnosing why the strategy may be stuck, informed by the actual
 * edits made in the failing attempt and by what earlier reflections this run already ruled out.
 * Its structured result is appended to the NEXT attempt's already-existing follow-up prompt.
 * Successful runs, first failures, changing failures, direct `new CodingAgent(...)` callers and
 * every non-coding Agent are unchanged.
 *
 * The wrapper uses the existing read-only explorer provider when configured, otherwise the main
 * provider. Reflection errors/timeouts are swallowed by CodingFailureReflector, so the base
 * CodingAgent's deterministic retry/non-convergence behavior remains the fallback.
 */
export class FailureAwareCodingAgent extends BaseCodingAgent {
  private readonly failureReflector: CodingFailureReflector;
  /** Own copy of the db handed to the constructor - the base class's own field of the same name
   *  is private and not visible to this subclass. Used only to read
   *  AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES so the reflection cadence below stays in sync
   *  with the threshold the base class's macro loop actually stops at. */
  private readonly settingsDb: DatabaseService;

  constructor(
    provider: LLMProvider,
    db: DatabaseService,
    eventEmitter?: AgentEventEmitter,
    options: CodingAgentOptions = {}
  ) {
    super(provider, db, eventEmitter, options);
    this.settingsDb = db;
    this.failureReflector = new CodingFailureReflector(
      options.explorerProvider ?? provider,
      getRootLogger().child("CodingFailureReflection")
    );
  }

  private async resolveMaxIdenticalVerifyFailures(): Promise<number> {
    const raw = parseInt((await this.settingsDb.getSetting("AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES")) ?? "", 10);
    return Number.isFinite(raw) ? Math.min(20, Math.max(1, raw)) : DEFAULT_MAX_IDENTICAL_VERIFY_FAILURES;
  }

  override async run(goal: string, options: CodingRunOptions = {}): Promise<CodingRunResult> {
    // `agent` is private in the mature base class. Keep the compatibility shim local to this
    // wrapper instead of widening CodingAgent's public API just for instrumentation. The shape is
    // guarded defensively; if it ever changes, simply fall back to the untouched base run.
    const innerAgent = (this as unknown as { agent?: {
      run: (prompt: string, options?: AgentRunOptions) => Promise<AgentRunResult>;
      executor?: {
        execute: (toolName: string, input: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<any>;
      };
    } }).agent;
    if (!innerAgent?.executor) return super.run(goal, options);

    const originalRun = innerAgent.run.bind(innerAgent);
    const originalExecute = innerAgent.executor.execute.bind(innerAgent.executor);
    const runState = new CodingRunState(await this.resolveMaxIdenticalVerifyFailures());
    let waitingForMacroVerify = false;
    let pendingReflection: CodingFailureReflection | undefined;
    // Edits made by the model DURING the attempt currently in flight - reset at the start of each
    // attempt, read once that attempt's macro verifier fails, so the reflector sees exactly what
    // this failing attempt tried instead of a stale set from an earlier one.
    let currentAttemptEdits: CodingFailureEditDiff[] = [];
    // "avoid" hints from every reflection this run has already produced, so a later reflection
    // (now possible more than once per run - see CodingRunState) doesn't re-suggest an approach a
    // prior diagnosis already ruled out.
    const ruledOutSoFar: string[] = [];

    innerAgent.run = async (prompt: string, runOptions?: AgentRunOptions): Promise<AgentRunResult> => {
      // An aborted/unchecked prior attempt can leave the flag set without ever reaching the macro
      // verifier. Starting the next inner run always establishes a new attempt boundary.
      waitingForMacroVerify = false;
      currentAttemptEdits = [];
      const reflectedPrompt = pendingReflection
        ? `${prompt}\n\n${formatFailureReflection(pendingReflection)}`
        : prompt;
      pendingReflection = undefined;

      const result = await originalRun(reflectedPrompt, runOptions);
      runState.lastSummary = result.response;
      if (result.runJournal) runState.journal = result.runJournal;
      waitingForMacroVerify = true;
      return result;
    };

    innerAgent.executor.execute = async (
      toolName: string,
      input: Record<string, unknown>,
      executeOptions?: { signal?: AbortSignal }
    ) => {
      const result = await originalExecute(toolName, input, executeOptions);

      // Track the model's own edits as they happen, before waitingForMacroVerify flips this
      // branch's sibling check below - a write/edit/append here is the model working on the
      // CURRENT attempt, never the macro verifier (that only ever calls "shell").
      if (toolName === "filesystem" && result?.success) {
        const action = String(input["action"] ?? "");
        if (EDIT_ACTIONS.has(action)) {
          const path = String(input["path"] ?? input["filePath"] ?? input["file"] ?? "unknown");
          const after = String(input["newString"] ?? input["content"] ?? "");
          const before = action === "edit" ? String(input["oldString"] ?? "") : undefined;
          currentAttemptEdits.push({ path, action, after, ...(before ? { before } : {}) });
        }
      }

      // Shell calls made BY the model happen inside originalRun(), before waitingForMacroVerify is
      // set. The first shell call after originalRun returns is the base CodingAgent's deterministic
      // macro verifier. No command-name allowlist or guess about the project's verify command is
      // needed, so auto-detected npm/pnpm/pytest/etc. verification remains compatible.
      if (waitingForMacroVerify && toolName === "shell") {
        waitingForMacroVerify = false;
        if (!result.success) {
          const verifyError = condenseVerifyOutput(
            result.error ?? JSON.stringify(result.data ?? "")
          );
          const failure = runState.recordVerifyFailure(verifyError);

          if (failure.shouldReflect) {
            const reflection = await this.failureReflector.reflect({
              goal,
              verifyCommand: String(input["command"] ?? "unknown verification command"),
              verifyError,
              previousSummary: runState.lastSummary,
              journal: runState.journal,
              recentEdits: currentAttemptEdits,
              previouslyRuledOut: ruledOutSoFar,
            });
            runState.markReflectionAttempted(reflection);
            if (reflection) {
              pendingReflection = reflection;
              ruledOutSoFar.push(...reflection.avoid);
              // Without this the reflection only ever reached the model, inside the next
              // attempt's prompt - the user watching the run never saw WHY the agent changed
              // strategy after a repeated failure, only that it eventually did something
              // different. Reuses the existing "decision" event channel so no frontend wiring
              // is needed beyond rendering `data.reflection` where other decision events render.
              this.emit("decision", `Fehleranalyse: ${reflection.diagnosis}`, { reflection });
            }
          }
        }
      }

      return result;
    };

    try {
      return await super.run(goal, options);
    } finally {
      // The underlying Agent instance is intentionally reusable. Never leave instrumentation on it
      // after this macro run; a later CodingAgent.run() must begin with a clean RunState.
      innerAgent.run = originalRun;
      innerAgent.executor.execute = originalExecute;
    }
  }
}

export function createFailureAwareCodingAgent(
  provider: LLMProvider,
  db: DatabaseService,
  eventEmitter?: AgentEventEmitter,
  options?: CodingAgentOptions
): BaseCodingAgent {
  return new FailureAwareCodingAgent(provider, db, eventEmitter, options);
}
