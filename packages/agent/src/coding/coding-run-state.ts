import type { RunJournalEntry } from "../config/interfaces_types.js";

export interface CodingFailureReflection {
  /** One concise root-cause hypothesis grounded in the verifier output. */
  diagnosis: string;
  /** Approaches the next attempt should explicitly avoid repeating. */
  avoid: string[];
  /** Concrete next checks/changes to try, ordered by usefulness. */
  nextActions: string[];
}

export interface CodingFailureSnapshot {
  verifyFailures: number;
  identicalFailureStreak: number;
  lastVerifyError?: string;
  reflection?: CodingFailureReflection;
}

export interface VerifyFailureUpdate extends CodingFailureSnapshot {
  identicalToPrevious: boolean;
  /** True after three consecutive attempts produced the exact same verifier output. */
  shouldStopForNonConvergence: boolean;
  /** True once per run: the first repeated failure is the useful point for a reflection pass. */
  shouldReflect: boolean;
}

/**
 * Mutable state for ONE CodingAgent.run() invocation.
 *
 * The macro loop used to keep its cross-attempt facts in unrelated local variables
 * (`journal`, `previousVerifyError`, `identicalFailureStreak`, `anyFileChangedThisRun`). That
 * worked while every decision lived in one method, but made it difficult for the status tool or
 * a targeted failure-analysis pass to consume the same ground truth without duplicating logic.
 *
 * This class is intentionally small and deterministic. It does not call an LLM, touch the DB, or
 * know about tools. It only owns facts that must survive from attempt N to attempt N+1. A fresh
 * instance is created for every CodingAgent.run(), so no state can bleed into a later user goal.
 */
export class CodingRunState {
  journal: RunJournalEntry[] = [];
  lastSummary = "";
  anyFileChanged = false;

  private previousVerifyError: string | undefined;
  private identicalFailureStreak = 0;
  private verifyFailures = 0;
  private reflection: CodingFailureReflection | undefined;

  /**
   * @param maxIdenticalVerifyFailures How many consecutive attempts may fail verification with
   *   the EXACT SAME error before the run is considered non-converging. Mirrors the
   *   AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES setting enforced by CodingAgent's own macro
   *   loop - kept in sync explicitly (rather than duplicated as a separate hardcoded constant)
   *   so this state's `shouldStopForNonConvergence` reports the same threshold the run will
   *   actually stop at. Default 3 matches the historical hardcoded behavior.
   */
  constructor(private readonly maxIdenticalVerifyFailures: number = 3) {}

  markFileChanges(changedFileCount: number): void {
    if (changedFileCount > 0) this.anyFileChanged = true;
  }

  recordVerifyFailure(error: string): VerifyFailureUpdate {
    const normalizedError = error.trim();
    const identicalToPrevious =
      this.previousVerifyError !== undefined && normalizedError === this.previousVerifyError.trim();

    this.verifyFailures++;
    this.identicalFailureStreak = identicalToPrevious ? this.identicalFailureStreak + 1 : 0;
    this.previousVerifyError = error;

    // identicalFailureStreak is "number of repeats AFTER the first occurrence":
    // 0 = first/different failure, 1 = same failure twice, 2 = same failure three times.
    const shouldStopForNonConvergence = this.identicalFailureStreak >= this.maxIdenticalVerifyFailures - 1;
    // Reflect on EVERY new repeat, not just the first - a higher maxIdenticalVerifyFailures
    // budget means more attempts sit between "first repeat" and the stop threshold, and each of
    // those deserves its own fresh diagnosis rather than coasting on one stale reflection from
    // several attempts back.
    const shouldReflect = identicalToPrevious && !shouldStopForNonConvergence;

    return {
      ...this.failureSnapshot(),
      identicalToPrevious,
      shouldStopForNonConvergence,
      shouldReflect,
    };
  }

  markReflectionAttempted(reflection?: CodingFailureReflection): void {
    if (reflection) this.reflection = reflection;
  }

  failureSnapshot(): CodingFailureSnapshot {
    return {
      verifyFailures: this.verifyFailures,
      identicalFailureStreak: this.identicalFailureStreak,
      ...(this.previousVerifyError ? { lastVerifyError: this.previousVerifyError } : {}),
      ...(this.reflection ? { reflection: this.reflection } : {}),
    };
  }
}
