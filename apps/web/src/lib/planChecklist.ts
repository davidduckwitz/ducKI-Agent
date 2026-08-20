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
