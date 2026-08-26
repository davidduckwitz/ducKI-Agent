import type { LLMMessage } from "@ducki/shared";

/**
 * Phase 1 "Critic": structured verification of an agent response against
 * concrete constraints, as opposed to Reflection's free-form quality score.
 *
 * A constraint is a single checkable requirement. Constraints are either
 * declared explicitly by the caller or derived from the user's request by the
 * Verifier itself (see `Verifier.deriveConstraints`).
 */

/**
 * Kind of check a constraint represents.
 * - "requirement": a functional requirement the response must satisfy (LLM-checked)
 * - "logic-assertion": a logical/consistency claim about the response (LLM-checked)
 * - "style": a formatting / presentation expectation (LLM-checked)
 * - "shell-check": a command whose exit code / output proves the claim
 *   (only runs when a shell executor is wired in; otherwise reported as "skipped")
 * - "unit-test": a test command that must pass (same executor gating as shell-check)
 */
export type VerifyConstraintKind =
  | "requirement"
  | "logic-assertion"
  | "style"
  | "shell-check"
  | "unit-test";

export interface VerifyConstraint {
  id: string;
  kind: VerifyConstraintKind;
  /** Human-readable description of what must hold. */
  description: string;
  /** For shell-check / unit-test: the command to run. */
  command?: string;
  /** For shell-check / unit-test: substring the stdout must contain to pass. */
  expectContains?: string;
}

export type VerifyStatus = "passed" | "failed" | "skipped";

export interface VerifyCheckResult {
  constraintId: string;
  kind: VerifyConstraintKind;
  description: string;
  status: VerifyStatus;
  /** Concrete reason a check failed or was skipped. */
  detail?: string;
}

export interface VerifyResult {
  /** Overall pass = every non-skipped check passed. */
  passed: boolean;
  checks: VerifyCheckResult[];
  /** Compact list of failing points, ready to feed into a fix prompt. */
  failures: string[];
  /** True when at least one check failed and a fix attempt is worthwhile. */
  shouldFix: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Per-constraint failure counts across the current fix loop. */
  constraintFailures?: Map<string, number>;
}

/**
 * A single fix attempt record — captured after each verify → fix cycle so the
 * next fix prompt can reference what was tried and what still failed.
 */
export interface VerifyFixAttempt {
  /** 1-indexed attempt number within the fix loop. */
  attempt: number;
  /** The response text BEFORE this fix was applied. */
  previousResponse: string;
  /** Failures that triggered this fix. */
  failures: string[];
  /** Whether the fix actually changed the response (false = model looped). */
  changed: boolean;
  /** Failing constraint IDs after this fix (empty = fix worked). */
  remainingFailureIds: string[];
}

/**
 * Compiled error context carried across the fix loop. Each iteration appends
 * its attempt record; the next fix prompt reads the full history to avoid
 * repeating strategies that already failed.
 */
export interface VerifyFixHistory {
  /** Total fix attempts so far. */
  totalAttempts: number;
  /** Per-constraint failure count: constraintId → how many times it still failed. */
  constraintFailures: Map<string, number>;
  /** Ordered log of each attempt. */
  attempts: VerifyFixAttempt[];
  /** IDs of constraints that have been failing for >= escalationThreshold attempts. */
  stalledConstraintIds: string[];
}

/**
 * Escalation level for a stalled constraint — the fix prompt becomes
 * progressively more specific as a constraint resists multiple fixes.
 */
export type FixEscalationLevel = "normal" | "detailed" | "drastic";

/**
 * Optional shell executor the Verifier uses to run shell-check / unit-test
 * constraints. Kept as a narrow injected interface so the agent can pass its
 * existing sandboxed shell tool without the verification module depending on it.
 */
export interface VerifyShellExecutor {
  run(command: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export const EMPTY_VERIFY_RESULT: VerifyResult = {
  passed: true,
  checks: [],
  failures: [],
  shouldFix: false,
};

/** Shared message shape re-export so callers don't import from two places. */
export type VerifyMessage = LLMMessage;

// ──────────────────────────────────────────────────────────────────────────────
// Fix-history helpers
// ──────────────────────────────────────────────────────────────────────────────

/** How many times a constraint must fail before escalating. */
const ESCALATION_THRESHOLD = 2;

/** Build an empty fix-history tracker. */
export function createEmptyFixHistory(): VerifyFixHistory {
  return {
    totalAttempts: 0,
    constraintFailures: new Map(),
    attempts: [],
    stalledConstraintIds: [],
  };
}

/** Record a fix attempt and update the running history. */
export function recordFixAttempt(
  history: VerifyFixHistory,
  attempt: number,
  previousResponse: string,
  failures: string[],
  changed: boolean,
  remainingFailureIds: string[]
): void {
  history.totalAttempts = attempt;
  history.attempts.push({
    attempt,
    previousResponse,
    failures,
    changed,
    remainingFailureIds,
  });

  // Update per-constraint failure counts.
  for (const id of remainingFailureIds) {
    history.constraintFailures.set(id, (history.constraintFailures.get(id) ?? 0) + 1);
  }

  // Mark stalled constraints — those currently failing AND with a high failure count.
  // If a constraint was fixed (not in remainingFailureIds), it is no longer stalled
  // even if it had a high historical count — the fix worked and the model should
  // focus on the remaining issues.
  history.stalledConstraintIds = [...history.constraintFailures.entries()]
    .filter(([id, count]) => count >= ESCALATION_THRESHOLD && remainingFailureIds.includes(id))
    .map(([id]) => id);
}

/** Determine the escalation level for a given constraint based on its failure count. */
export function getEscalationLevel(history: VerifyFixHistory, constraintId: string): FixEscalationLevel {
  const failures = history.constraintFailures.get(constraintId) ?? 0;
  if (failures >= 4) return "drastic";
  if (failures >= ESCALATION_THRESHOLD) return "detailed";
  return "normal";
}

/**
 * Compile a human-readable fix-context block that the next fix prompt can
 * reference. Includes attempt history, stalled constraints, and escalation
 * hints — so the model doesn't repeat strategies that already failed.
 */
export function compileFixContext(history: VerifyFixHistory): string {
  if (history.attempts.length === 0) return "";

  const lines: string[] = [];

  // Summarise prior attempts.
  lines.push(`Prior fix attempts: ${history.attempts.length}`);
  for (const a of history.attempts) {
    const tag = a.changed ? "(changed response)" : "(no change — model looped)";
    lines.push(`  Attempt ${a.attempt}: ${tag}`);
    if (a.failures.length > 0) {
      lines.push(`    Still failing: ${a.failures.slice(0, 3).join("; ")}`);
    }
  }

  // Highlight stalled constraints.
  if (history.stalledConstraintIds.length > 0) {
    lines.push("");
    lines.push("CONSTRAINTS REQUIRING DIFFERENT APPROACH:");
    for (const id of history.stalledConstraintIds) {
      const level = getEscalationLevel(history, id);
      const count = history.constraintFailures.get(id) ?? 0;
      lines.push(`  ${id}: failed ${count}x — escalation level: ${level}`);
    }
  }

  // Actionable hints for the fix model.
  lines.push("");
  lines.push("GUIDELINES FOR THIS FIX:");
  if (history.stalledConstraintIds.length > 0) {
    lines.push("- For stalled constraints: try a fundamentally different approach, not incremental tweaks.");
    lines.push("- Consider restructuring the answer, adding missing sections, or correcting factual errors.");
  } else {
    lines.push("- Address only the remaining failures; do not rewrite parts that already pass.");
  }
  if (history.attempts.some((a) => !a.changed)) {
    lines.push("- Previous fix produced no change — you MUST modify the response text.");
  }
  lines.push("- Return ONLY the corrected answer, no commentary.");

  return lines.join("\n");
}
