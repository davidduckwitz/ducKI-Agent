import type { RenderedChatMessage } from "../components/chat/chatTypes";

/** Terminal states: the agent will not come back to such a step. */
const CLOSED_STATUSES = new Set(["done", "failed", "skipped"]);

export interface ChecklistSnapshot {
  /** stepIndex -> status. The primary link: checklist items are derived from the plan steps in order. */
  statusByIndex: Map<number, string>;
  /** Lowercased title -> status. Fallback for a plan whose steps were re-derived out of order. */
  statusByTitle: Map<string, string>;
  doneCount: number;
  total: number;
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
export function findLatestChecklist(messages: RenderedChatMessage[]): ChecklistSnapshot | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.eventType !== "checklist" || !message.eventData) continue;

    const items = message.eventData["items"];
    if (!Array.isArray(items)) continue;

    const statusByIndex = new Map<number, string>();
    const statusByTitle = new Map<string, string>();
    for (const raw of items) {
      const item = (raw ?? {}) as { index?: number; title?: string; status?: string };
      const status = String(item.status ?? "pending");
      if (typeof item.index === "number") statusByIndex.set(item.index, status);
      if (typeof item.title === "string" && item.title.trim()) {
        statusByTitle.set(item.title.trim().toLowerCase(), status);
      }
    }
    if (statusByIndex.size === 0 && statusByTitle.size === 0) continue;

    const doneCount = Number(message.eventData["doneCount"]);
    const total = Number(message.eventData["total"]);
    return {
      statusByIndex,
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
  return findLatestTodoSnapshot(messages);
}

/** Maps CodingAgent's TodoList status vocabulary onto the one this module (and the panel) was
 *  originally built against (see the "checklist" event parsing above). "in_progress" has no
 *  distinct visual here - the panel's spinner comes from firstOpenStepIndex, not from the status
 *  string - so it only needs to stay OUT of CLOSED_STATUSES; "blocked" reads as "failed" since
 *  both mean "the agent stopped making progress on this step without help". */
const TODO_STATUS_MAP: Record<string, string> = {
  pending: "pending",
  in_progress: "pending",
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
function findLatestTodoSnapshot(messages: RenderedChatMessage[]): ChecklistSnapshot | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.eventType !== "decision" || !message.eventData) continue;

    const items = message.eventData["todo_items"];
    if (!Array.isArray(items)) continue;

    const statusByIndex = new Map<number, string>();
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

    return { statusByIndex, statusByTitle, doneCount, total: items.length };
  }
  return null;
}

export function resolveStepStatus(
  snapshot: ChecklistSnapshot | null,
  step: { title: string },
  index: number
): string | undefined {
  if (!snapshot) return undefined;
  return snapshot.statusByIndex.get(index) ?? snapshot.statusByTitle.get(step.title.trim().toLowerCase());
}

/**
 * Index of the step currently being worked on: the first one that is not in a terminal state.
 *
 * Derived from the statuses themselves rather than from a "completed count", so a step the
 * agent failed or skipped does not push the running marker onto the wrong row - which a
 * counter-based approach does as soon as anything goes other than perfectly.
 */
export function firstOpenStepIndex(
  snapshot: ChecklistSnapshot | null,
  steps: Array<{ title: string }>
): number {
  return steps.findIndex((step, index) => !CLOSED_STATUSES.has(resolveStepStatus(snapshot, step, index) ?? "pending"));
}
