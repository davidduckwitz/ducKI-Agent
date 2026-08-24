import type { RenderedChatMessage } from "../components/chat/chatTypes";

/** The five phases CodingAgent declares via ">> PHASE: X" / "<< X COMPLETE" markers. */
export const CODING_PHASES = ["explore", "plan", "edit", "verify", "report"] as const;
export type CodingPhase = (typeof CODING_PHASES)[number];

export interface PhaseProgress {
  /** The phase the agent is currently in, if it has started one and not finished it. */
  current: CodingPhase | undefined;
  /** Phases that have completed. */
  completed: Set<CodingPhase>;
  /** Phases that failed. */
  failed: Set<CodingPhase>;
  /** Attempt number from the latest phase event, when present. */
  attempt: number | undefined;
}

const PHASE_EVENTS = new Set(["phase_started", "phase_completed", "phase_failed"]);

/**
 * Reconstructs the agent's current phase from its `internal_instruction` phase events.
 *
 * CodingAgent emits one event per phase transition (see emitPhase in coding-agent.ts), each
 * carrying `phase` (explore/plan/edit/verify/report) and `phase_event` (started/completed/failed).
 * Walking the events in order and keeping the LAST event per phase gives the same state the
 * phase-lock hook tracks internally: a phase is completed if its last event is "completed", and
 * the current phase is the first phase in sequence whose last event is "started".
 *
 * Extracted from the component for the same reason planChecklist.ts exists: the inline version
 * was untestable, and a phase display is exactly the kind of logic that regresses silently.
 */
export function findLatestPhaseProgress(messages: RenderedChatMessage[]): PhaseProgress {
  const lastStatus = new Map<CodingPhase, string>();
  let attempt: number | undefined;

  for (const message of messages) {
    if (!message || message.eventType !== "internal_instruction" || !message.eventData) continue;

    const phase = message.eventData["phase"];
    const phaseEvent = message.eventData["phase_event"];
    if (typeof phase !== "string" || typeof phaseEvent !== "string") continue;
    if (!PHASE_EVENTS.has(phaseEvent)) continue;
    if (!(CODING_PHASES as readonly string[]).includes(phase)) continue;

    lastStatus.set(phase as CodingPhase, phaseEvent);
    const eventAttempt = message.eventData["attempt"];
    if (typeof eventAttempt === "number") attempt = eventAttempt;
  }

  const completed = new Set<CodingPhase>();
  const failed = new Set<CodingPhase>();
  let current: CodingPhase | undefined;

  for (const phase of CODING_PHASES) {
    const status = lastStatus.get(phase);
    if (status === "phase_completed") completed.add(phase);
    else if (status === "phase_failed") failed.add(phase);
    else if (status === "phase_started") {
      current = phase;
      break;
    }
  }

  return { current, completed, failed, attempt };
}

/** Human label per phase, in the coding directive's own language (English markers, German UI). */
export const CODING_PHASE_LABEL: Record<CodingPhase, string> = {
  explore: "Erkunden",
  plan: "Planen",
  edit: "Editieren",
  verify: "Prüfen",
  report: "Bericht",
};
