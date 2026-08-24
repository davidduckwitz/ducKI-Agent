import { describe, it, expect } from "vitest";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * Regression coverage for the phase-result merge: the live emission path
 * (updatePhaseFromResponse) emits phase_started/phase_completed without the text between the
 * markers, while the end-of-attempt backfill (extractAndEmitPhaseEvents) extracts that text.
 * emitPhase must merge that richer payload into a supplementary "phase_result" row instead of
 * silently dropping it - and without emitting a second "phase completed" transition.
 */
function buildCodingAgent(): { agent: CodingAgent; added: Array<Record<string, unknown>> } {
  const provider = {
    generate: async () => ({ content: "" }),
    generateStream: async () => ({ content: "" }),
    supportsStreaming: () => false,
  } as any;
  const added: Array<Record<string, unknown>> = [];
  const db = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
    addMessage: async (m: Record<string, unknown>) => {
      added.push(m);
      return undefined;
    },
  } as any;
  return { agent: new CodingAgent(provider, db, undefined, {}), added };
}

function parseToolResult(row: Record<string, unknown>): { eventType: string; data: Record<string, unknown> } {
  return JSON.parse(String(row["toolResult"])) as { eventType: string; data: Record<string, unknown> };
}

describe("CodingAgent phase-result merge", () => {
  it("persists a supplementary phase_result row when a duplicate completed event adds the result text", async () => {
    const { agent, added } = buildCodingAgent();
    (agent as any).currentConversationId = 1;

    // Live path: started + completed, no result.
    (agent as any).emitPhase({ type: "phase_started", phase: "edit", title: "Edit", timestamp: "t1", attempt: 1 });
    (agent as any).emitPhase({ type: "phase_completed", phase: "edit", title: "Edit", timestamp: "t2", attempt: 1 });

    // Backfill: duplicate completed event WITH the result text.
    (agent as any).emitPhase({
      type: "phase_completed",
      phase: "edit",
      title: "Edit",
      result: "changed src/foo.ts",
      timestamp: "t3",
      attempt: 1,
    });

    // Flush the persistence queue.
    await (agent as any).eventPersistQueue;

    const rows = added.map(parseToolResult);
    expect(rows.map((r) => r.eventType)).toEqual(["internal_instruction", "internal_instruction", "internal_instruction"]);

    // The phase bar never sees a second "phase completed" - the third row is a result-only row.
    expect(rows[0]!.data["phase_event"]).toBe("phase_started");
    expect(rows[1]!.data["phase_event"]).toBe("phase_completed");
    expect(rows[1]!.data["result"]).toBeUndefined();

    const resultRow = rows[2]!;
    expect(resultRow.data["phase_event"]).toBe("phase_result");
    expect(resultRow.data["phase"]).toBe("edit");
    expect(resultRow.data["result"]).toBe("changed src/foo.ts");
  });

  it("does not persist a second result row for an identical backfill duplicate", async () => {
    const { agent, added } = buildCodingAgent();
    (agent as any).currentConversationId = 1;

    (agent as any).emitPhase({ type: "phase_completed", phase: "report", title: "Report", timestamp: "t1", attempt: 1 });
    (agent as any).emitPhase({ type: "phase_completed", phase: "report", title: "Report", result: "done", timestamp: "t2", attempt: 1 });
    (agent as any).emitPhase({ type: "phase_completed", phase: "report", title: "Report", result: "done", timestamp: "t3", attempt: 1 });

    await (agent as any).eventPersistQueue;

    const resultRows = added.map(parseToolResult).filter((r) => r.data["phase_event"] === "phase_result");
    expect(resultRows).toHaveLength(1);
  });

  it("never regresses a completed phase back to started via the backfill", async () => {
    const { agent, added } = buildCodingAgent();
    (agent as any).currentConversationId = 1;

    (agent as any).emitPhase({ type: "phase_started", phase: "edit", title: "Edit", timestamp: "t1", attempt: 1 });
    (agent as any).emitPhase({ type: "phase_completed", phase: "edit", title: "Edit", timestamp: "t2", attempt: 1 });
    // Backfill re-emits the STARTED event (lower rank) - it must be dropped entirely.
    (agent as any).emitPhase({ type: "phase_started", phase: "edit", title: "Edit", timestamp: "t3", attempt: 1 });

    await (agent as any).eventPersistQueue;

    const phases = added.map(parseToolResult).map((r) => r.data["phase_event"]);
    expect(phases).toEqual(["phase_started", "phase_completed"]);
  });
});
