import type { RenderedChatMessage } from "../components/chat/chatTypes";

/** Terminal states: the agent will not come back to such a step. */
const CLOSED_STATUSES = new Set(["done", "failed", "skipped"]);

export interface ChecklistSnapshot {
  statusById: Map<string, string>;
  /** stepIndex -> status. The primary link: checklist items are derived from the plan steps in order. */
  statusByIndex: Map<number, string>;
  /** Lowercased title -> status. Fallback for a plan whose steps were re-derived out of order. */
  statusByTitle: Map<string, string>;
  doneCount: number;
  total: number;
}

export interface PlanEventScope { runId?: string; planId?: number; }

function inScope(message: RenderedChatMessage, scope?: PlanEventScope): boolean {
  if (!scope) return true;
  if (scope.runId && message.eventData?.["runId"] !== scope.runId) return false;
  if (scope.planId !== undefined && Number(message.eventData?.["planId"]) !== scope.planId) return false;
  return true;
}

/**
 * The agent's own per-step state, taken from the most recent checklist event.
 *
 * Every checklist event ("created", "progress", "done") carries the COMPLETE item list with
 * each step's current status, so the newest one is the whole truth - no merging of partial
 * updates, and no chance of showing a half-applied state.
 *
 * This exists because the coding plan panel used to guess instead: it counted tool_call and
 * tool_result events after the plan and treated that number as "steps completed". That was
 * wrong in both directions - a step was only ever drawn as done while the run was NOT loading,
 * so nothing could be ticked off during execution and the marker appeared stuck on step 1; and
 * once finished, the count was a number of tool calls, which has no relation to how many steps
 * actually succeeded.
 */
export function findLatestChecklist(messages: RenderedChatMessage[], scope?: PlanEventScope): ChecklistSnapshot | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.eventType !== "checklist" || !message.eventData || !inScope(message, scope)) continue;

    const items = message.eventData["items"];
    if (!Array.isArray(items)) continue;

    const statusByIndex = new Map<number, string>();
    const statusById = new Map<string, string>();
    const statusByTitle = new Map<string, string>();
    for (const raw of items) {
      const item = (raw ?? {}) as { id?: string; stepId?: string; index?: number; title?: string; status?: string };
      const status = String(item.status ?? "pending");
      if (typeof item.index === "number") statusByIndex.set(item.index, status);
      const stepId = item.stepId ?? item.id;
      if (typeof stepId === "string" && stepId) statusById.set(stepId, status);
      if (typeof item.title === "string" && item.title.trim()) {
        statusByTitle.set(item.title.trim().toLowerCase(), status);
      }
    }
    if (statusByIndex.size === 0 && statusByTitle.size === 0) continue;

    const doneCount = Number(message.eventData["doneCount"]);
    const total = Number(message.eventData["total"]);
    return {
      statusByIndex,
      statusById,
      statusByTitle,
      doneCount: Number.isFinite(doneCount)
        ? doneCount
        : [...statusByIndex.values()].filter((s) => s === "done").length,
      total: Number.isFinite(total) ? total : items.length,
    };
  }
  // No "checklist" event this run - the common case for a plain CodingAgent run, which never
  // produces one (that event belongs to the generic Agent's own internal session checklist, a
  // separate opt-in subsystem CodingAgent doesn't enable for its own per-attempt calls). Fall
  // back to CodingAgent's OWN live per-step source instead of giving up: see
  // findLatestTodoSnapshot below. Priority is deliberate - a real "checklist" event, when
  // present, is left completely untouched by this fallback.
  return findLatestTodoSnapshot(messages, scope);
}

/**
 * Maps CodingAgent's TodoList status vocabulary onto the one this module (and the panel) was
 * originally built against (see the "checklist" event parsing above).
 *
 * "in_progress" is now PRESERVED as its own status instead of being flattened to "pending":
 * it is the single most informative signal in the plan view - it tells the user exactly which
 * step the agent is working on right now. The panel renders it as a spinner and
 * firstOpenStepIndex prefers it (see below). "blocked" still reads as "failed" since both mean
 * "the agent stopped making progress on this step without help".
 */
const TODO_STATUS_MAP: Record<string, string> = {
  pending: "pending",
  in_progress: "in_progress",
  done: "done",
  blocked: "failed",
};

/**
 * Fallback source of live per-step status for a run that produced no Agent-level "checklist"
 * event: CodingAgent's own TodoList (packages/agent/src/coding/todo-tool.ts), seeded from the
 * plan's step titles and updated live as the model calls the `todo` tool. Every change emits
 * `type: "decision"` with `data.todo_items` - a different shape from the "checklist" event this
 * file originally read, so it gets its own reader rather than being force-fit into the one above.
 *
 * Without this, the coding plan panel had NO live source for a plain CodingAgent run: every step
 * fell back to "pending" regardless of how far the agent's own checklist had actually progressed,
 * looking like the plan had reset even though the run continued correctly underneath.
 */
function findLatestTodoSnapshot(messages: RenderedChatMessage[], scope?: PlanEventScope): ChecklistSnapshot | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.eventType !== "decision" || !message.eventData || !inScope(message, scope)) continue;

    const items = message.eventData["todo_items"];
    if (!Array.isArray(items)) continue;

    const statusByIndex = new Map<number, string>();
    const statusById = new Map<string, string>();
    const statusByTitle = new Map<string, string>();
    let doneCount = 0;
    for (const raw of items) {
      const item = (raw ?? {}) as { id?: number; title?: string; status?: string };
      const mapped = TODO_STATUS_MAP[String(item.status ?? "pending")] ?? "pending";
      if (mapped === "done") doneCount++;
      // TodoList ids are assigned in the SAME order the plan's steps were originally seeded
      // (CodingAgent.run(): this.todos.replace(plan.steps.map(...))), so id-1 is a reasonable
      // positional guess - but the title is the more reliable link if the model later rewrote
      // the checklist (todo action:write again) with a different order, added, or removed steps.
      if (typeof item.id === "number") statusByIndex.set(item.id - 1, mapped);
      if (typeof item.title === "string" && item.title.trim()) {
        statusByTitle.set(item.title.trim().toLowerCase(), mapped);
      }
    }
    if (statusByIndex.size === 0 && statusByTitle.size === 0) continue;

    return { statusById, statusByIndex, statusByTitle, doneCount, total: items.length };
  }
  return null;
}

/** PlanStep.status (packages/agent/src/planner/planner.ts) -> this module's vocabulary - the
 *  inverse of CodingAgent's own TODO_TO_PLAN_STATUS map (coding-agent.ts), kept in sync with it. */
const PLAN_STEP_STATUS_MAP: Record<string, string> = {
  pending: "pending",
  running: "in_progress",
  completed: "done",
  failed: "failed",
};

/**
 * Fallback per-step status built directly from a persisted Plan's own steps (see
 * CodingPlanPanel's latestPersistedPlan) - used only when neither a "checklist" event nor a
 * CodingAgent "decision"/todo_items event survives in the currently-loaded (paginated) message
 * window anymore. CodingAgent keeps the plans-table row's steps in sync with the live TodoList
 * on every checklist change (see syncPlanFromTodos in coding-agent.ts), so this stays current
 * even once nothing about it is visible in messages - just coarser than the live sources (no
 * separate "skipped" status; PlanStep.status has no such state).
 */
export function checklistFromPlanSteps(
  steps: Array<{ id?: string; title: string; status?: string }>
): ChecklistSnapshot | null {
  if (steps.length === 0) return null;
  const statusByIndex = new Map<number, string>();
  const statusById = new Map<string, string>();
  const statusByTitle = new Map<string, string>();
  let doneCount = 0;
  steps.forEach((step, index) => {
    const mapped = PLAN_STEP_STATUS_MAP[String(step.status ?? "pending")] ?? "pending";
    if (mapped === "done") doneCount++;
    statusByIndex.set(index, mapped);
    if (step.id) statusById.set(step.id, mapped);
    if (step.title?.trim()) statusByTitle.set(step.title.trim().toLowerCase(), mapped);
  });
  return { statusByIndex, statusById, statusByTitle, doneCount, total: steps.length };
}

export function resolveStepStatus(
  snapshot: ChecklistSnapshot | null,
  step: { id?: string; title: string },
  index: number
): string | undefined {
  if (!snapshot) return undefined;
  return (step.id ? snapshot.statusById.get(step.id) : undefined) ?? snapshot.statusByIndex.get(index) ?? snapshot.statusByTitle.get(step.title.trim().toLowerCase());
}

/**
 * Index of the step currently being worked on.
 *
 * Preference order:
 * 1. The step the agent itself marked "in_progress" (the authoritative signal - the todo tool
 *    says "mark a step in_progress before you start it").
 * 2. The first step that is not in a terminal state (fallback for runs where the model never
 *    marks in_progress but still makes progress).
 *
 * Deriving it from "first open step" alone is wrong whenever a step is skipped/blocked or the
 * model marks steps done out of order: the spinner then sits on the wrong row while the agent
 * works elsewhere. The in_progress status is the direct answer to "what is the agent doing NOW".
 */
export function firstOpenStepIndex(
  snapshot: ChecklistSnapshot | null,
  steps: Array<{ title: string }>
): number {
  if (!snapshot) return -1;

  // Prefer the step the agent itself flagged as in_progress.
  const runningIndex = steps.findIndex(
    (step, index) => resolveStepStatus(snapshot, step, index) === "in_progress"
  );
  if (runningIndex >= 0) return runningIndex;

  // Fallback: first non-terminal step.
  return steps.findIndex(
    (step, index) => !CLOSED_STATUSES.has(resolveStepStatus(snapshot, step, index) ?? "pending")
  );
}
