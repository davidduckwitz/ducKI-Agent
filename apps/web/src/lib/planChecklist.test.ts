import { describe, expect, it } from "vitest";
import { checklistFromPlanSteps, findLatestChecklist, firstOpenStepIndex, resolveStepStatus } from "./planChecklist";
import type { RenderedChatMessage } from "../components/chat/chatTypes";

let nextId = 0;
const event = (eventType: string, eventData?: Record<string, unknown>): RenderedChatMessage => ({
  id: `e${nextId++}`,
  role: "event",
  content: "",
  timestamp: new Date().toISOString(),
  eventType: eventType as RenderedChatMessage["eventType"],
  ...(eventData ? { eventData } : {}),
});

/** Shape the agent actually emits (agent.ts: phase created/progress/done). */
const checklistEvent = (
  statuses: string[],
  phase: "created" | "progress" | "done" = "progress"
): RenderedChatMessage =>
  event("checklist", {
    phase,
    runId: "run-1",
    total: statuses.length,
    doneCount: statuses.filter((s) => s === "done").length,
    items: statuses.map((status, index) => ({ index, title: `Schritt ${index + 1}`, status })),
  });

const steps = [
  { title: "Schritt 1" },
  { title: "Schritt 2" },
  { title: "Schritt 3" },
  { title: "Schritt 4" },
];

describe("findLatestChecklist", () => {
  it("isolates snapshots by plan run instead of leaking the newest conversation-wide checklist", () => {
    const olderRun = checklistEvent(["done", "pending"]);
    const newerRun = event("checklist", {
      runId: "run-2", total: 2, doneCount: 2,
      items: [{ index: 0, title: "Schritt 1", status: "done" }, { index: 1, title: "Schritt 2", status: "done" }],
    });
    const snapshot = findLatestChecklist([olderRun, newerRun], { runId: "run-1" });
    expect(snapshot?.doneCount).toBe(1);
  });
  it("returns null when the run produced no checklist", () => {
    // A plain coding chat has no plan execution and therefore no per-step truth. The panel
    // must show nothing rather than invent progress - which is what the old tool-call counter
    // did, and why finished runs showed the wrong steps ticked.
    const messages = [event("plan", { goal: "g" }), event("tool_call"), event("tool_result")];
    expect(findLatestChecklist(messages)).toBeNull();
  });

  it("takes the NEWEST event, not an accumulation of them", () => {
    const messages = [
      checklistEvent(["pending", "pending", "pending", "pending"], "created"),
      checklistEvent(["done", "pending", "pending", "pending"]),
      checklistEvent(["done", "done", "pending", "pending"]),
    ];
    const snapshot = findLatestChecklist(messages)!;
    expect(snapshot.doneCount).toBe(2);
    expect(snapshot.statusByIndex.get(1)).toBe("done");
    expect(snapshot.statusByIndex.get(2)).toBe("pending");
  });

  it("ignores unrelated events that come after it", () => {
    const messages = [
      checklistEvent(["done", "done", "pending", "pending"]),
      event("tool_call"),
      event("reasoning"),
    ];
    expect(findLatestChecklist(messages)?.doneCount).toBe(2);
  });

  it("survives a malformed payload by looking further back", () => {
    const messages = [
      checklistEvent(["done", "pending", "pending", "pending"]),
      event("checklist", { phase: "progress", items: "not-an-array" }),
    ];
    expect(findLatestChecklist(messages)?.doneCount).toBe(1);
  });

  it("recomputes doneCount when the event omits it", () => {
    const messages = [
      event("checklist", {
        items: [
          { index: 0, title: "Schritt 1", status: "done" },
          { index: 1, title: "Schritt 2", status: "done" },
          { index: 2, title: "Schritt 3", status: "pending" },
        ],
      }),
    ];
    expect(findLatestChecklist(messages)?.doneCount).toBe(2);
  });
});

/** Shape CodingAgent's TodoList actually emits (coding-agent.ts's onChange callback). */
const todoDecisionEvent = (statuses: Array<"pending" | "in_progress" | "done" | "blocked">): RenderedChatMessage =>
  event("decision", {
    todo_items: statuses.map((status, index) => ({ id: index + 1, title: `Schritt ${index + 1}`, status })),
    open: statuses.filter((s) => s === "pending" || s === "in_progress").length,
  });

describe("findLatestChecklist - CodingAgent TodoList fallback", () => {
  it("falls back to the todo_items decision event when no checklist event exists", () => {
    // The bug this fixes: a plain CodingAgent run never emits an Agent-level "checklist" event,
    // so the panel used to fall back to null and show every step as pending, looking like the
    // plan had reset even though the agent's own todo checklist had already progressed.
    const messages = [
      event("plan", { goal: "g" }),
      todoDecisionEvent(["done", "in_progress", "pending", "pending"]),
    ];
    const snapshot = findLatestChecklist(messages);
    expect(snapshot?.doneCount).toBe(1);
    expect(snapshot?.statusByIndex.get(0)).toBe("done");
    expect(resolveStepStatus(snapshot, steps[0]!, 0)).toBe("done");
  });

  it("prefers a real checklist event over the todo fallback when both exist", () => {
    // A "checklist" event (the Agent-level session checklist) is the more authoritative source
    // when it's actually present - the fallback must never override it.
    const messages = [
      todoDecisionEvent(["pending", "pending", "pending", "pending"]),
      checklistEvent(["done", "done", "pending", "pending"]),
    ];
    expect(findLatestChecklist(messages)?.doneCount).toBe(2);
  });

  it("takes the newest todo_items event, not an accumulation", () => {
    const messages = [
      todoDecisionEvent(["pending", "pending", "pending", "pending"]),
      todoDecisionEvent(["done", "pending", "pending", "pending"]),
      todoDecisionEvent(["done", "done", "pending", "pending"]),
    ];
    expect(findLatestChecklist(messages)?.doneCount).toBe(2);
  });

  it("maps 'blocked' to 'failed' and keeps 'in_progress' out of CLOSED_STATUSES", () => {
    const snapshot = findLatestChecklist([todoDecisionEvent(["done", "blocked", "in_progress", "pending"])]);
    expect(resolveStepStatus(snapshot, steps[1]!, 1)).toBe("failed");
    // "in_progress" (index 2) is where the agent is working, so it is the running step even
    // though "blocked" (index 1) is terminal and would otherwise be skipped over.
    expect(firstOpenStepIndex(snapshot, steps)).toBe(2);
  });

  it("falls back to title matching when todo ids drift from plan step order", () => {
    const messages = [
      event("decision", {
        todo_items: [{ id: 7, title: "Schritt 3", status: "done" }],
      }),
    ];
    const snapshot = findLatestChecklist(messages);
    expect(resolveStepStatus(snapshot, { title: "  schritt 3  " }, 99)).toBe("done");
  });

  it("still returns null when neither a checklist nor a todo_items event exists", () => {
    const messages = [event("plan", { goal: "g" }), event("tool_call"), event("tool_result")];
    expect(findLatestChecklist(messages)).toBeNull();
  });
});

describe("resolveStepStatus", () => {
  it("matches by step index", () => {
    const snapshot = findLatestChecklist([checklistEvent(["done", "failed", "pending", "pending"])]);
    expect(resolveStepStatus(snapshot, steps[0]!, 0)).toBe("done");
    expect(resolveStepStatus(snapshot, steps[1]!, 1)).toBe("failed");
    expect(resolveStepStatus(snapshot, steps[2]!, 2)).toBe("pending");
  });

  it("falls back to the title when the index is missing", () => {
    const messages = [
      event("checklist", {
        items: [{ title: "Schritt 3", status: "done" }],
        total: 4,
        doneCount: 1,
      }),
    ];
    const snapshot = findLatestChecklist(messages);
    expect(resolveStepStatus(snapshot, { title: "  schritt 3  " }, 99)).toBe("done");
  });

  it("returns undefined without a checklist", () => {
    expect(resolveStepStatus(null, steps[0]!, 0)).toBeUndefined();
  });
});

describe("firstOpenStepIndex", () => {
  it("points at the first unfinished step", () => {
    const snapshot = findLatestChecklist([checklistEvent(["done", "done", "pending", "pending"])]);
    expect(firstOpenStepIndex(snapshot, steps)).toBe(2);
  });

  it("skips past a failed or skipped step instead of parking on it", () => {
    // A counter-based marker sat on the wrong row as soon as anything went other than
    // perfectly - "2 completed" pointed at step 3 even when step 2 had failed.
    const snapshot = findLatestChecklist([checklistEvent(["done", "failed", "skipped", "pending"])]);
    expect(firstOpenStepIndex(snapshot, steps)).toBe(3);
  });

  it("is the first step while nothing has been done yet", () => {
    const snapshot = findLatestChecklist([checklistEvent(["pending", "pending", "pending", "pending"], "created")]);
    expect(firstOpenStepIndex(snapshot, steps)).toBe(0);
  });

  it("is -1 once every step reached a terminal state", () => {
    const snapshot = findLatestChecklist([checklistEvent(["done", "done", "done", "skipped"], "done")]);
    expect(firstOpenStepIndex(snapshot, steps)).toBe(-1);
  });

  it("treats an unverified step as still open", () => {
    // "unverified" means the agent could not prove it - not that it is finished.
    const snapshot = findLatestChecklist([checklistEvent(["done", "unverified", "pending", "pending"], "done")]);
    expect(firstOpenStepIndex(snapshot, steps)).toBe(1);
  });

  it("prefers the in_progress step over the first merely-open step", () => {
    // The bug this fixes: in_progress used to be flattened to "pending", so the running marker
    // sat on the first open step (index 1) while the agent actually worked on index 2.
    const snapshot = findLatestChecklist([todoDecisionEvent(["done", "pending", "in_progress", "pending"])]);
    expect(resolveStepStatus(snapshot, steps[2]!, 2)).toBe("in_progress");
    expect(firstOpenStepIndex(snapshot, steps)).toBe(2);
  });

  it("falls back to the first open step when nothing is in_progress", () => {
    const snapshot = findLatestChecklist([todoDecisionEvent(["done", "pending", "pending", "pending"])]);
    expect(firstOpenStepIndex(snapshot, steps)).toBe(1);
  });
});

describe("the regression this replaced", () => {
  it("marks steps done DURING a run, not only after it", () => {
    // The old rendering required !isLoading for a step to count as done, so mid-run the list
    // showed a single spinner and nothing ticked - the reported "stays on the first step".
    const snapshot = findLatestChecklist([checklistEvent(["done", "done", "pending", "pending"])]);
    const doneDuringRun = steps.filter((step, index) => resolveStepStatus(snapshot, step, index) === "done");
    expect(doneDuringRun).toHaveLength(2);
  });

  it("does not equate tool activity with completed steps", () => {
    // Twelve tool events, one completed step. The old panel would have ticked off all four.
    const messages = [
      checklistEvent(["done", "pending", "pending", "pending"]),
      ...Array.from({ length: 12 }, () => event("tool_call")),
    ];
    const snapshot = findLatestChecklist(messages)!;
    expect(snapshot.doneCount).toBe(1);
    expect(firstOpenStepIndex(snapshot, steps)).toBe(1);
  });
});

describe("checklistFromPlanSteps", () => {
  // Regression: the Plan tab's progress used to reset to "nothing done" once a long run pushed
  // every live checklist/decision event out of the paginated message window, even though the
  // plan itself was still visible (via latestPersistedPlan). This is the fallback source that
  // keeps step progress in sync with the persisted plans-table row instead.
  it("maps PlanStep.status onto the checklist vocabulary and counts done steps", () => {
    const snapshot = checklistFromPlanSteps([
      { id: "step_1", title: "Schritt 1", status: "completed" },
      { id: "step_2", title: "Schritt 2", status: "running" },
      { id: "step_3", title: "Schritt 3", status: "pending" },
      { id: "step_4", title: "Schritt 4", status: "failed" },
    ]);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.doneCount).toBe(1);
    expect(snapshot!.total).toBe(4);
    expect(snapshot!.statusById.get("step_1")).toBe("done");
    expect(snapshot!.statusById.get("step_2")).toBe("in_progress");
    expect(snapshot!.statusById.get("step_3")).toBe("pending");
    expect(snapshot!.statusById.get("step_4")).toBe("failed");
    expect(snapshot!.statusByIndex.get(1)).toBe("in_progress");
    expect(snapshot!.statusByTitle.get("schritt 1")).toBe("done");
  });

  it("returns null for an empty step list instead of a fake empty snapshot", () => {
    expect(checklistFromPlanSteps([])).toBeNull();
  });

  it("defaults a step with no status to pending", () => {
    const snapshot = checklistFromPlanSteps([{ title: "Schritt 1" }]);
    expect(snapshot!.statusByIndex.get(0)).toBe("pending");
  });
});
