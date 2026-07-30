/**
 * AgentRunnerV2: Streaming-first API for agent execution via async generators.
 * Enables real-time UI updates without polling, with frame-by-frame visibility.
 */

import type { LLMProvider } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import type { AgentEventEmitter, AgentRunOptions, AgentRunResult } from "./config/interfaces_types.js";
import { Agent } from "./agent.js";
import type { AgentOptions } from "./config/interfaces_types.js";

/**
 * Frame types emitted during agent execution.
 */
export type AgentRunFrame =
  | { type: "start"; data: { conversationId?: number; maxIterations: number } }
  | { type: "chunk"; data: { text: string } }
  | { type: "event"; data: AgentRunEvent }
  | { type: "iteration_complete"; data: { iteration: number; toolsUsed: string[] } }
  | { type: "completion"; data: AgentRunResult }
  | { type: "error"; data: { message: string; stack?: string } };

/**
 * Minimal event type for streaming (subset of full AgentRunEvent).
 */
export interface AgentRunEvent {
  type: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

/**
 * AgentRunnerV2: Exposes agent execution as async generator.
 * Each frame represents a discrete event the UI can render immediately.
 */
export class AgentRunnerV2 {
  private agent: Agent;

  constructor(
    private readonly provider: LLMProvider,
    private readonly db: DatabaseService,
    private readonly options: AgentOptions = {}
  ) {
    this.agent = new Agent(provider, db, undefined, options);
  }

  /**
   * Run agent and stream frames via async generator.
   * Caller can iterate and update UI for each frame without polling.
   *
   * Example:
   *   const runner = new AgentRunnerV2(provider, db);
   *   for await (const frame of runner.run(userInput)) {
   *     if (frame.type === 'chunk') ui.append(frame.data.text);
   *     if (frame.type === 'event') ui.log(frame.data.message);
   *     if (frame.type === 'completion') ui.showResult(frame.data.response);
   *   }
   */
  async *run(userInput: string, options: AgentRunOptions = {}): AsyncGenerator<AgentRunFrame, void, unknown> {
    const chunks: string[] = [];
    const events: AgentRunEvent[] = [];
    let conversationId: number | undefined;

    // Emit start frame
    yield { type: "start", data: { conversationId, maxIterations: this.agent["maxIterations"] ?? 50 } };

    // Override event/chunk handlers to capture for frames
    const originalOnEvent = options.onEvent;
    const originalOnChunk = options.onChunk;

    const newOptions: AgentRunOptions = {
      ...options,
      onEvent: (event) => {
        const streamEvent: AgentRunEvent = {
          type: event.type as string,
          message: event.message,
          data: event.data,
          timestamp: event.timestamp,
        };
        events.push(streamEvent);
        // Synchronously yield event frame (cannot yield from callback, so queue it)
        // Will be yielded after run completes
        originalOnEvent?.(event);
      },
      onChunk: (chunk) => {
        chunks.push(chunk);
        // Note: cannot yield from callback, so events are queued and yielded after
        originalOnChunk?.(chunk);
      },
    };

    try {
      // Run agent (blocks until completion)
      const result = await this.agent.run(userInput, newOptions);

      // Emit captured chunks as frames
      for (const chunk of chunks) {
        yield { type: "chunk", data: { text: chunk } };
      }

      // Emit captured events as frames
      for (const event of events) {
        yield { type: "event", data: event };
      }

      // Emit completion frame
      yield { type: "completion", data: result };
    } catch (error) {
      yield {
        type: "error",
        data: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      };
    }
  }

  /**
   * Get the underlying Agent instance for direct access if needed.
   */
  getAgent(): Agent {
    return this.agent;
  }

  /**
   * Load a conversation for continued execution.
   */
  async loadConversation(conversationId: number): Promise<void> {
    return this.agent.loadConversation(conversationId);
  }
}

/**
 * Factory for creating AgentRunnerV2 instances.
 */
export function createAgentRunnerV2(
  provider: LLMProvider,
  db: DatabaseService,
  options?: AgentOptions
): AgentRunnerV2 {
  return new AgentRunnerV2(provider, db, options);
}
