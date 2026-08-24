import { describe, expect, it } from "vitest";
import { parsePersistedEvent, isWhitelistedEventType } from "./persistedEventTypes";
import { findLatestPhaseProgress } from "./planPhase";
import { findLatestChecklist, resolveStepStatus, firstOpenStepIndex } from "./planChecklist";
import type { RenderedChatMessage } from "../components/chat/chatTypes";

/**
 * End-to-end reload coverage for the two sources the plan view depends on:
 * the phase bar (internal_instruction events with phase/phase_event) and the checklist
 * (decision events carrying todo_items). The server persists every CodingAgent event as
 * `toolResult = JSON.stringify({ eventType, data, timestamp })`; on reload the frontend maps
 * that back through parsePersistedEvent. This test simulates the full persisted -> rendered
 * round-trip so a regression in the whitelist or the payload shape fails here, not on a reload.
 */

let nextId = 0;
const persistedRow = (eventType: string, data: Record<string, unknown>): RenderedChatMessage => {
  const toolResult = JSON.stringify({ eventType, data, timestamp: new Date().toISOString() });
  const { eventType: type, eventData } = parsePersistedEvent(toolResult);
  return {
    id: `db-${nextId++}`,
    role: "event",
    content: "",
    timestamp: new Date().toISOString(),
    eventType: type,
    eventData,
  };
};

describe("parsePersistedEvent", () => {
  it("whitelists the phase/todo event types the plan view depends on", () => {
    expect(isWhitelistedEventType("internal_instruction")).toBe(true);
    expect(isWhitelistedEventType("decision")).toBe(true);
    expect(isWhitelistedEventType("plan")).toBe(true);
  });

  it("reconstructs eventData verbatim from the persisted payload", () => {
    const toolResult = JSON.stringify({
      eventType: "internal_instruction",
      data: { phase: "edit", phase_event: "phase_started", attempt: 2 },
      timestamp: "t",
    });
    const parsed = parsePersistedEvent(toolResult);
    expect(parsed.eventType).toBe("internal_instruction");
    expect(parsed.eventData).toEqual({ phase: "edit", phase_event: "phase_started", attempt: 2 });
  });

  it("drops unknown event types and malformed payloads", () => {
    expect(parsePersistedEvent(JSON.stringify({ eventType: "secret_internal_row", data: {} })).eventType).toBeUndefined();
    expect(parsePersistedEvent("not json {").eventType).toBeUndefined();
    expect(parsePersistedEvent(null).eventType).toBeUndefined();
  });
});

describe("phase bar survives a reload", () => {
  it("reconstructs the current phase from persisted internal_instruction rows", () => {
    const messages = [
      persistedRow("internal_instruction", { phase: "explore", phase_event: "phase_completed", attempt: 1 }),
      persistedRow("internal_instruction", { phase: "plan", phase_event: "phase_completed", attempt: 1 }),
      persistedRow("internal_instruction", { phase: "edit", phase_event: "phase_started", attempt: 1 }),
    ];
    const progress = findLatestPhaseProgress(messages);
    expect(progress.current).toBe("edit");
    expect(progress.completed.has("explore")).toBe(true);
    expect(progress.completed.has("plan")).toBe(true);
    expect(progress.attempt).toBe(1);
  });
});

describe("checklist survives a reload", () => {
  it("reconstructs per-step status from persisted decision/todo_items rows", () => {
    const messages = [
      persistedRow("decision", {
        todo_items: [
          { id: 1, title: "Read the router", status: "done" },
          { id: 2, title: "Add the endpoint", status: "in_progress" },
          { id: 3, title: "Verify with tsc", status: "pending" },
        ],
        open: 2,
      }),
    ];
    const snapshot = findLatestChecklist(messages);
    expect(snapshot?.doneCount).toBe(1);

    const steps = [{ title: "Read the router" }, { title: "Add the endpoint" }, { title: "Verify with tsc" }];
    expect(resolveStepStatus(snapshot, steps[0]!, 0)).toBe("done");
    expect(resolveStepStatus(snapshot, steps[1]!, 1)).toBe("in_progress");
    // The running step is the in_progress one, not the first merely-open one.
    expect(firstOpenStepIndex(snapshot, steps)).toBe(1);
  });
});
