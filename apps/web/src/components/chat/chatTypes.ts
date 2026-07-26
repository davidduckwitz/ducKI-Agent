export type AgentEventType =
  | "plan"
  | "iteration"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "decision"
  | "guardrail"
  | "mode_selected"
  | "browser_preview";

export interface RenderedChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "event" | "tool";
  content: string;
  timestamp: string;
  eventType?: AgentEventType;
  eventData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
