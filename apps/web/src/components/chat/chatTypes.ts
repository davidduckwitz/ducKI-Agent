export type AgentEventType =
  | "plan"
  | "iteration"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "decision"
  | "guardrail"
  | "skill_selection"
  | "tool_retry"
  | "mode_selected"
  | "browser_preview"
  | "thinking"
  | "internal_instruction";

/**
 * A chat message as rendered in the UI.
 *
 * For event messages (role="event"), eventData may contain:
 * - thinking: Raw thinking string (for reasoning/thinking events)
 * - thinkBlocks?: Array of parsed think blocks with metadata
 *   { id, content, thinkingDepth, tokenEstimate, toolCalls[] }
 * - toolName: Name of tool being invoked/completed
 * - success: Whether a tool call succeeded
 * - Various token counts (inputTokens, outputTokens, totalTokens)
 */
export interface RenderedChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "event" | "tool";
  content: string;
  timestamp: string;
  eventType?: AgentEventType;
  /** Structured data associated with this event (think blocks, tool info, etc.) */
  eventData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
