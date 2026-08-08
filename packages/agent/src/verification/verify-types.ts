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
}

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
