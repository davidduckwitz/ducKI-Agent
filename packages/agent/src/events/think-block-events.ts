/**
 * Think Block Event Emitter
 *
 * Converts parsed think blocks into AgentRunEvents for streaming over WebSocket.
 * Handles both complete think blocks and streaming deltas.
 */

import type { ThinkBlock, ToolCallReference } from "../parsers/think-block-parser.js";
import { AGENT_EVENT_TYPES, type AgentRunEvent, type AgentRunEventSnapshot } from "./agent-events.js";

export class ThinkBlockEventEmitter {
  /**
   * Create a THINK_BLOCK_STARTED event (when streaming begins)
   */
  static createStartEvent(
    thinkBlockId: string,
    snapshot?: AgentRunEventSnapshot
  ): AgentRunEvent {
    return {
      type: AGENT_EVENT_TYPES.THINK_BLOCK_STARTED,
      message: "Agent is thinking about this problem...",
      data: {
        thinkBlockId,
        timestamp: new Date().toISOString(),
      },
      snapshot,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Create a THINK_BLOCK_DELTA event (for streaming content chunks)
   */
  static createDeltaEvent(
    thinkBlockId: string,
    delta: string,
    currentLength: number,
    snapshot?: AgentRunEventSnapshot
  ): AgentRunEvent {
    return {
      type: AGENT_EVENT_TYPES.THINK_BLOCK_DELTA,
      message: `Thinking... (${currentLength} chars)`,
      data: {
        thinkBlockId,
        delta,
        currentLength,
        timestamp: new Date().toISOString(),
      },
      snapshot,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Create a THINK_BLOCK_COMPLETED event (when streaming ends)
   */
  static createCompletedEvent(
    thinkBlock: ThinkBlock,
    snapshot?: AgentRunEventSnapshot
  ): AgentRunEvent {
    return {
      type: AGENT_EVENT_TYPES.THINK_BLOCK_COMPLETED,
      message: `Agent completed thinking (${thinkBlock.thinkingDepth} depth, ${thinkBlock.toolCalls.length} tool refs)`,
      data: {
        thinkBlockId: thinkBlock.id,
        content: thinkBlock.content,
        thinkingDepth: thinkBlock.thinkingDepth,
        tokenEstimate: thinkBlock.tokenEstimate,
        toolCallsCount: thinkBlock.toolCalls.length,
        toolCalls: thinkBlock.toolCalls,
        duration: thinkBlock.endTime
          ? thinkBlock.endTime.getTime() - thinkBlock.startTime.getTime()
          : undefined,
        timestamp: new Date().toISOString(),
      },
      snapshot,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Create a complete THINK_BLOCK with metadata for UI rendering
   */
  static createThinkBlockData(thinkBlock: ThinkBlock): Record<string, unknown> {
    return {
      thinkBlocks: [
        {
          id: thinkBlock.id,
          content: thinkBlock.content,
          thinkingDepth: thinkBlock.thinkingDepth,
          tokenEstimate: thinkBlock.tokenEstimate,
          toolCalls: thinkBlock.toolCalls,
          status: thinkBlock.status,
          startTime: thinkBlock.startTime.toISOString(),
          endTime: thinkBlock.endTime?.toISOString(),
        },
      ],
      isStreaming: thinkBlock.status === "streaming",
    };
  }
}

/**
 * Agent Question Event Emitter
 *
 * Emits events for agent clarification questions and user responses.
 */
export class AgentQuestionEventEmitter {
  /**
   * Create an AGENT_QUESTION_ASKED event
   */
  static createQuestionEvent(
    questionId: string,
    question: string,
    context?: string,
    importance?: "low" | "medium" | "high",
    snapshot?: AgentRunEventSnapshot
  ): AgentRunEvent {
    return {
      type: AGENT_EVENT_TYPES.AGENT_QUESTION_ASKED,
      message: question,
      data: {
        questionId,
        question,
        context,
        importance: importance || "medium",
        timestamp: new Date().toISOString(),
      },
      snapshot,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Create an AGENT_QUESTION_ANSWERED event
   */
  static createAnswerEvent(
    questionId: string,
    question: string,
    response: string,
    snapshot?: AgentRunEventSnapshot
  ): AgentRunEvent {
    return {
      type: AGENT_EVENT_TYPES.AGENT_QUESTION_ANSWERED,
      message: `User responded to: ${question}`,
      data: {
        questionId,
        question,
        response,
        timestamp: new Date().toISOString(),
      },
      snapshot,
      timestamp: new Date().toISOString(),
    };
  }
}
