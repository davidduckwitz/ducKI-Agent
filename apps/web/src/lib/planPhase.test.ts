import { describe, expect, it } from "vitest";
import { findLatestPhaseProgress } from "./planPhase";
import type { RenderedChatMessage } from "../components/chat/chatTypes";

let nextId = 0;
const phaseEvent = (phase: string, phase_event: string, attempt = 1): RenderedChatMessage => ({
  id: `e${nextId++}`,
  role: "event",
  content: "",
  timestamp: new Date().toISOString(),
  eventType: "internal_instruction",
  eventData: { phase, phase_event, attempt },
});

describe("findLatestPhaseProgress", () => {
  it("returns no current phase for a run with no phase events", () => {
    const messages: RenderedChatMessage[] = [
      { id: "1", role: "event", content: "", timestamp: "", eventType: "plan" },
    ];
    const progress = findLatestPhaseProgress(messages);
    expect(progress.current).toBeUndefined();
    expect(progress.completed.size).toBe(0);
    expect(progress.failed.size).toBe(0);
  });

  it("tracks the current phase as the first started-but-not-finished phase", () => {
    const messages = [
      phaseEvent("explore", "phase_completed"),
      phaseEvent("plan", "phase_completed"),
      phaseEvent("edit", "phase_started"),
    ];
    const progress = findLatestPhaseProgress(messages);
    expect(progress.current).toBe("edit");
    expect(progress.completed.has("explore")).toBe(true);
    expect(progress.completed.has("plan")).toBe(true);
  });

  it("keeps the last status per phase (a re-started phase is not still completed)", () => {
    const messages = [
      phaseEvent("edit", "phase_started"),
      phaseEvent("edit", "phase_failed"),
      phaseEvent("edit", "phase_started"), // retried
    ];
    const progress = findLatestPhaseProgress(messages);
    expect(progress.failed.has("edit")).toBe(false);
    expect(progress.current).toBe("edit");
  });

  it("marks a phase failed when its last event is phase_failed", () => {
    const messages = [phaseEvent("verify", "phase_failed")];
    const progress = findLatestPhaseProgress(messages);
    expect(progress.failed.has("verify")).toBe(true);
    expect(progress.completed.has("verify")).toBe(false);
  });

  it("carries the attempt number from the latest phase event", () => {
    const messages = [
      phaseEvent("explore", "phase_started", 1),
      phaseEvent("edit", "phase_started", 2),
    ];
    expect(findLatestPhaseProgress(messages).attempt).toBe(2);
  });
});
