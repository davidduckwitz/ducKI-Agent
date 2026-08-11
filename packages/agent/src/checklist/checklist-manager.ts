import type { Logger } from "@ducki/logger";
import type { Plan, PlanStep } from "../planner/planner.js";
import type { Verifier } from "../verification/verifier.js";
import type { VerifyConstraint, VerifyConstraintKind, VerifyResult } from "../verification/verify-types.js";

/**
 * Phase 2 of the session-checklist feature: turn a Plan into a persisted checklist
 * and resolve individual items against the Verifier.
 *
 * The manager is deliberately STATELESS and DB-agnostic — it talks to a narrow
 * `ChecklistStore` (structurally satisfied by DatabaseService) so it can be unit
 * tested with a mocked verifier and either a real or fake store. All open-goal
 * state lives in the DB; the run-loop (Phase 3/4) reads it back each iteration.
 */

/** Row shape as returned by the store (subset of SessionChecklistSelect we rely on). */
export interface ChecklistItem {
  id: number;
  conversationId: number;
  runId: string | null;
  stepIndex: number;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  constraintKind: string | null;
  status: string;
  confidence: string | null;
  verifyState: string | null;
  attempts: number;
}

/** Narrow persistence surface the manager needs. DatabaseService satisfies this. */
export interface ChecklistStore {
  createChecklist(
    conversationId: number,
    runId: string | undefined,
    items: Array<{
      title: string;
      description?: string | null;
      acceptanceCriteria?: string | null;
      constraintKind?: string | null;
      stepIndex?: number;
      status?: string;
    }>
  ): Promise<ChecklistItem[]>;
  getChecklist(conversationId: number, runId?: string): Promise<ChecklistItem[]>;
  getOpenChecklistItems(conversationId: number, runId?: string): Promise<ChecklistItem[]>;
  updateChecklistItem(
    id: number,
    data: Partial<{
      status: string;
      confidence: string | null;
      verifyState: string | null;
      attempts: number;
      acceptanceCriteria: string | null;
      constraintKind: string | null;
    }>
  ): Promise<ChecklistItem | undefined>;
  deleteChecklist(conversationId: number, runId?: string): Promise<void>;
}

/** Terminal/interim states used across the manager and the run-loop. */
export type ChecklistItemStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "unverified"
  | "skipped";

/** Outcome of resolving one item against the Verifier. */
export interface ChecklistResolution {
  itemId: number;
  status: ChecklistItemStatus;
  confidence?: "verified" | "soft";
  failures: string[];
  verify: VerifyResult;
}

/** Only strongly code-specific tools imply a coding step — filesystem/shell are too
 *  generic (a general task saves files too), mirroring the Planner's classifyGoal. */
const CODING_TOOL_SIGNALS = new Set(["coding", "git"]);

/** True when a step is clearly a coding step, so its acceptance criteria can be checked
 *  by an executable (shell/test) rather than only by an LLM. */
function isCodingStep(step: PlanStep, planType: Plan["planType"]): boolean {
  if (planType === "coding") return true;
  return (step.toolsNeeded ?? []).some((t) => CODING_TOOL_SIGNALS.has(t.toLowerCase()));
}

/**
 * Choose the verification kind for a step's acceptance criteria.
 *
 * Non-code steps are ALWAYS given an LLM-checkable kind (requirement) and NEVER a
 * shell-check — this is by design so a general step is never wrongly reported as
 * "skipped" just because no shell executor is wired in. Coding steps keep
 * "requirement" too at derive time; a future revision may upgrade them to
 * shell-check/unit-test when a concrete command is known.
 */
export function pickConstraintKind(step: PlanStep, planType: Plan["planType"]): VerifyConstraintKind {
  // Coding steps could be upgraded to executable checks later; today both paths use
  // the LLM-checkable "requirement" so verification works without a shell executor.
  void isCodingStep(step, planType);
  return "requirement";
}

/** Compact, human-readable acceptance criteria for a step. */
export function deriveAcceptanceCriteria(step: PlanStep): string {
  const base = (step.description ?? "").trim() || step.title.trim();
  // Phrase as a testable statement so the Verifier's LLM checker can grade it.
  return `Der Schritt "${step.title}" ist erfüllt: ${base}`;
}

/**
 * Map a VerifyResult to an item status + confidence per the design table:
 *  - no checks / all skipped  → unverified (soft)   [transient or not hard-checkable]
 *  - any failed               → failed
 *  - otherwise (a real pass)  → done (verified)
 */
export function deriveItemStatus(verify: VerifyResult): { status: ChecklistItemStatus; confidence?: "verified" | "soft" } {
  const checks = verify.checks ?? [];
  const allSkipped = checks.length === 0 || checks.every((c) => c.status === "skipped");
  if (allSkipped) return { status: "unverified", confidence: "soft" };
  if (checks.some((c) => c.status === "failed")) return { status: "failed" };
  return { status: "done", confidence: "verified" };
}

export class ChecklistManager {
  constructor(
    private readonly store: ChecklistStore,
    private readonly logger: Logger
  ) {}

  /**
   * Create a checklist for a run from a Plan. Best-effort: on any store error it
   * logs and returns an empty array so a failure here never breaks the run.
   */
  async deriveFromPlan(plan: Plan, conversationId: number, runId?: string): Promise<ChecklistItem[]> {
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    if (steps.length === 0) return [];

    const items = steps.map((step, idx) => ({
      title: step.title,
      description: step.description ?? null,
      acceptanceCriteria: deriveAcceptanceCriteria(step),
      constraintKind: pickConstraintKind(step, plan.planType),
      stepIndex: idx,
      status: "pending",
    }));

    try {
      return await this.store.createChecklist(conversationId, runId, items);
    } catch (error) {
      this.logger.warn("Failed to persist checklist", {
        error: error instanceof Error ? error.message : String(error),
        conversationId,
        runId,
      });
      return [];
    }
  }

  /** First open (pending/in_progress) item for a run, or undefined when all resolved. */
  async nextOpen(conversationId: number, runId?: string): Promise<ChecklistItem | undefined> {
    const open = await this.store.getOpenChecklistItems(conversationId, runId);
    return open[0];
  }

  /** True when no open items remain for the run. */
  async allSatisfied(conversationId: number, runId?: string): Promise<boolean> {
    const open = await this.store.getOpenChecklistItems(conversationId, runId);
    return open.length === 0;
  }

  /** Mark an item as being worked on. */
  async markInProgress(itemId: number): Promise<void> {
    await this.store.updateChecklistItem(itemId, { status: "in_progress" });
  }

  /**
   * Verify a single item against accumulated evidence and persist the outcome.
   *
   * `evidence` is the compiled record of what actually happened for this step
   * (recent assistant text + tool results), NOT just the final prose — a mid-task
   * step's proof lives in the tool results. `attempts` is always incremented so the
   * run-loop can bound repair attempts.
   */
  async verifyAndMark(
    item: ChecklistItem,
    originalRequest: string,
    evidence: string,
    verifier: Verifier
  ): Promise<ChecklistResolution> {
    const constraint: VerifyConstraint = {
      id: `step-${item.stepIndex}`,
      kind: (item.constraintKind as VerifyConstraintKind) || "requirement",
      description: item.acceptanceCriteria || `Der Schritt "${item.title}" ist erfüllt.`,
    };

    let verify: VerifyResult;
    try {
      verify = await verifier.verify(originalRequest, evidence, [constraint]);
    } catch (error) {
      // A transient verifier failure must not crash the run: treat as unverified/soft.
      this.logger.warn("Checklist item verification threw, treating as unverified", {
        error: error instanceof Error ? error.message : String(error),
        itemId: item.id,
      });
      verify = { passed: true, checks: [], failures: [], shouldFix: false };
    }

    const { status, confidence } = deriveItemStatus(verify);
    const attempts = (item.attempts ?? 0) + 1;

    await this.store.updateChecklistItem(item.id, {
      status,
      confidence: confidence ?? null,
      attempts,
      verifyState: JSON.stringify({
        passed: verify.passed,
        failures: verify.failures.slice(0, 5),
        checks: verify.checks.map((c) => ({ status: c.status, kind: c.kind })),
      }),
    });

    return { itemId: item.id, status, confidence, failures: verify.failures, verify };
  }

  /**
   * Mid-run, non-destructive advance: verify the current open item against accumulated
   * evidence and mark it `done` ONLY when it clearly passes (verified). Unlike
   * `verifyAndMark`, this NEVER marks `failed`/`unverified` and NEVER consumes an attempt —
   * so it can be called speculatively while the model is still working: it can only move the
   * pointer forward when a step is genuinely finished, never penalize a step whose work isn't
   * done yet. A transient verifier error is swallowed (returns false); the end-of-loop
   * `verifyAndMark` remains the authority for failure/skip handling.
   */
  async tryAdvanceDuringRun(
    item: ChecklistItem,
    originalRequest: string,
    evidence: string,
    verifier: Verifier
  ): Promise<boolean> {
    const constraint: VerifyConstraint = {
      id: `step-${item.stepIndex}`,
      kind: (item.constraintKind as VerifyConstraintKind) || "requirement",
      description: item.acceptanceCriteria || `Der Schritt "${item.title}" ist erfüllt.`,
    };

    let verify: VerifyResult;
    try {
      verify = await verifier.verify(originalRequest, evidence, [constraint]);
    } catch {
      return false; // transient — leave the pointer; the end-phase re-checks with full budget
    }

    const { status, confidence } = deriveItemStatus(verify);
    if (status !== "done") return false; // not clearly finished yet — no state change, no cost to the attempt budget

    await this.store.updateChecklistItem(item.id, {
      status: "done",
      confidence: confidence ?? "verified",
      verifyState: JSON.stringify({
        passed: verify.passed,
        failures: verify.failures.slice(0, 5),
        checks: verify.checks.map((c) => ({ status: c.status, kind: c.kind })),
      }),
    });
    return true;
  }

  /** Force a still-open item to skipped (used when max repair attempts are exhausted). */
  async skip(itemId: number): Promise<void> {
    await this.store.updateChecklistItem(itemId, { status: "skipped" });
  }

  /** Render the current checklist as markdown for UI/logging. Pure over the given items. */
  static renderMarkdown(items: ChecklistItem[]): string {
    if (items.length === 0) return "_Keine Checkliste._";
    const icon: Record<string, string> = {
      done: "✅",
      failed: "⚠️",
      in_progress: "⏳",
      unverified: "🟡",
      skipped: "⏭️",
      pending: "⬜",
    };
    const doneCount = items.filter((i) => i.status === "done" || i.status === "unverified").length;
    const lines = [`### Checkliste (${doneCount}/${items.length})`, ""];
    for (const item of [...items].sort((a, b) => a.stepIndex - b.stepIndex)) {
      const badge = item.status === "unverified" ? " _(unbestätigt)_" : "";
      lines.push(`${icon[item.status] ?? "⬜"} ${item.stepIndex + 1}. ${item.title}${badge}`);
    }
    return lines.join("\n");
  }
}
