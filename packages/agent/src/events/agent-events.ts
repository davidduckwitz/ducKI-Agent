/**
 * Granular event types for agent execution with rich context snapshots.
 * 13+ event types provide visibility into every phase of agent reasoning and tool use.
 */

/**
 * Comprehensive snapshot of agent execution state, included with every event.
 * Enables UI to reconstruct exact state at any point in the run.
 */
export interface AgentRunEventSnapshot {
  conversationLength: number;
  currentIteration: number;
  maxIterations: number;
  toolsUsedThisIteration: string[];
  toolsUsedInRun: string[];
  estimatedTokensUsed?: number;
  memoryContextSize?: number;
  elapsed: number; // milliseconds since run start
  timestamp: string; // ISO 8601
}

/**
 * Granular event types emitted during agent execution.
 */
export const AGENT_EVENT_TYPES = {
  /** Input messages prepared, system prompt finalized, before model call. */
  MODEL_INPUT_PREPARED: "model_input_prepared",

  /** Model generation started (streaming begins). */
  MODEL_GENERATION_STARTED: "model_generation_started",

  /** Model response text received (delta during streaming). */
  MODEL_TEXT_DELTA: "model_text_delta",

  /** Model generation completed (all deltas received). */
  MODEL_GENERATION_COMPLETED: "model_generation_completed",

  /** Tool call candidate extracted from model response. */
  TOOL_CANDIDATE_EXTRACTED: "tool_candidate_extracted",

  /** Tool input validation started. */
  TOOL_VALIDATION_STARTED: "tool_validation_started",

  /** Tool input validation completed. */
  TOOL_VALIDATION_COMPLETED: "tool_validation_completed",

  /** Tool execution started (before tool.execute()). */
  TOOL_EXECUTION_STARTED: "tool_execution_started",

  /** Tool execution completed successfully. */
  TOOL_EXECUTION_COMPLETED: "tool_execution_completed",

  /** Tool execution failed (tool threw error). */
  TOOL_EXECUTION_FAILED: "tool_execution_failed",

  /** Tool approval check started (if policy enabled). */
  TOOL_APPROVAL_STARTED: "tool_approval_started",

  /** Tool approval denied. */
  TOOL_APPROVAL_DENIED: "tool_approval_denied",

  /** Tool approval pending (requires confirmation). */
  TOOL_APPROVAL_PENDING: "tool_approval_pending",

  /** Tool input was corrected by approval policy. */
  TOOL_INPUT_CORRECTED: "tool_input_corrected",

  /** Tool result converted to message and added to conversation. */
  TOOL_RESULT_ADDED: "tool_result_added",

  /** Reasoning checkpoint (periodic state snapshot). */
  REASONING_CHECKPOINT: "reasoning_checkpoint",

  /** Iteration loop completed (about to decide next action). */
  ITERATION_COMPLETE: "iteration_complete",

  /** Completion decision made (success, max iterations, error, etc.). */
  COMPLETION_DECISION: "completion_decision",

  /** Skill was auto-selected for this run. */
  SKILL_AUTO_SELECTED: "skill_auto_selected",

  /** Memory fact learned and stored. */
  MEMORY_STORED: "memory_stored",

  /** Memory context queried and retrieved. */
  MEMORY_QUERIED: "memory_queried",

  /** Approximation enabled (model response incomplete, agent will continue). */
  APPROXIMATION_ENABLED: "approximation_enabled",

  /** Input normalization applied (aliases resolved, JSON repaired, etc.). */
  INPUT_NORMALIZATION: "input_normalization",

  /** Think block streaming started (Phase 2). */
  THINK_BLOCK_STARTED: "think_block_started",

  /** Think block content delta received during streaming (Phase 2). */
  THINK_BLOCK_DELTA: "think_block_delta",

  /** Think block streaming completed (Phase 2). */
  THINK_BLOCK_COMPLETED: "think_block_completed",

  /** Agent asking clarification question (Phase 3). */
  AGENT_QUESTION_ASKED: "agent_question_asked",

  /** User response to agent question received (Phase 3). */
  AGENT_QUESTION_ANSWERED: "agent_question_answered",

  // Legacy event types (backward compat)
  PLAN: "plan",
  ITERATION: "iteration",
  TOOL_CALL: "tool_call",
  TOOL_RESULT: "tool_result",
  REASONING: "reasoning",
  DECISION: "decision",
  GUARDRAIL: "guardrail",
  MODE_SELECTED: "mode_selected",
  BROWSER_PREVIEW: "browser_preview",
} as const;

export type AgentRunEventType = typeof AGENT_EVENT_TYPES[keyof typeof AGENT_EVENT_TYPES];

/**
 * Complete event structure emitted by agent.
 */
export interface AgentRunEvent {
  type: AgentRunEventType;
  message: string;
  data?: Record<string, unknown>;
  snapshot?: AgentRunEventSnapshot;
  timestamp: string; // ISO 8601
}

/**
 * Event emitter interface for subscribing to agent events.
 */
export interface AgentEventEmitter {
  emitChunk(chunk: string): void;
  emitEvent(event: AgentRunEvent): void;
}
