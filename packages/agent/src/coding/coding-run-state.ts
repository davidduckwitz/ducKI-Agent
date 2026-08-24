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
  private reflectionUsed = false;
  private reflection: CodingFailureReflection | undefined;

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
    const shouldStopForNonConvergence = this.identicalFailureStreak >= 2;
    const shouldReflect = identicalToPrevious && !shouldStopForNonConvergence && !this.reflectionUsed;

    return {
      ...this.failureSnapshot(),
      identicalToPrevious,
      shouldStopForNonConvergence,
      shouldReflect,
    };
  }

  markReflectionAttempted(reflection?: CodingFailureReflection): void {
    this.reflectionUsed = true;
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
