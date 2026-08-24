import type { AgentEventType } from "../components/chat/chatTypes";

/**
 * The set of event types the server persists as `role:"event"` rows that the UI is allowed to
 * reconstruct. Anything outside this list is dropped on reload - not because it is malformed,
 * but because it is an internal row the user should not see (or a type this frontend does not
 * know how to render).
 *
 * This list used to be copy-pasted into BOTH CodingWorkspace.tsx and ChatContainer.tsx, and one
 * copy drifted (missing "checklist" and "assistant_text"), which silently lost the per-step
 * checklist on reload. One shared, tested source prevents that drift from happening again.
 */
const WHITELISTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "plan",
  "checklist",
  "iteration",
  "tool_call",
  "tool_result",
  "reasoning",
  "decision",
  "guardrail",
  "skill_selection",
  "tool_retry",
  "mode_selected",
  "browser_preview",
  "thinking",
  "internal_instruction",
  "assistant_text",
]);

/** True when a persisted `eventType` string is one this UI knows how to render. */
export function isWhitelistedEventType(type: string | undefined): type is AgentEventType {
  return typeof type === "string" && WHITELISTED_EVENT_TYPES.has(type);
}

export interface ParsedPersistedEvent {
  eventType: AgentEventType | undefined;
  eventData: Record<string, unknown> | undefined;
}

/**
 * Reconstructs a persisted `role:"event"` row's `toolResult` JSON into the same shape the live
 * WebSocket path delivers: an `eventType` plus a structured `eventData` payload.
 *
 * The server persists every agent event as `toolResult = JSON.stringify({ eventType, data, timestamp })`
 * (see CodingAgent.persistEvent and Agent.run's internal emit). On reload we parse that back and
 * only keep types in the whitelist. Malformed payloads degrade to an undefined event rather than
 * crashing the whole message list.
 */
export function parsePersistedEvent(toolResult: string | null | undefined): ParsedPersistedEvent {
  if (!toolResult) return { eventType: undefined, eventData: undefined };

  try {
    const parsed = JSON.parse(toolResult) as { eventType?: string; data?: Record<string, unknown> };
    const type = isWhitelistedEventType(parsed.eventType) ? parsed.eventType : undefined;
    return { eventType: type, eventData: parsed.data };
  } catch {
    return { eventType: undefined, eventData: undefined };
  }
}
