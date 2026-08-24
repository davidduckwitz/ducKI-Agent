/**
 * AgentRunnerV2: Streaming-first API for agent execution via async generators.
 * Emits chunks/events while Agent.run() is still in flight instead of buffering
 * everything until completion.
 */

import type { LLMProvider } from "@ducki/providers";
import type { DatabaseService } from "@ducki/database";
import type { AgentOptions, AgentRunOptions, AgentRunResult } from "./config/interfaces_types.js";
import { Agent } from "./agent.js";

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
 * Tiny single-consumer async queue bridging synchronous Agent callbacks into an
 * async generator. Frames are delivered FIFO in the exact callback order in which
 * they were produced, even when Agent.run() is still waiting on the model/tool loop.
 */
class AsyncFrameQueue<T> {
  private readonly values: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter && this.values.length === 0) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.waiter = resolve;
    });
  }
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
   * The previous implementation collected onChunk/onEvent callbacks into arrays and
   * yielded those arrays only AFTER Agent.run() resolved. That looked like a streaming
   * API but had completion-time latency. This implementation starts Agent.run() in the
   * background and bridges each callback into an async FIFO immediately.
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
    const queue = new AsyncFrameQueue<AgentRunFrame>();
    const originalOnEvent = options.onEvent;
    const originalOnChunk = options.onChunk;
    let settled = false;

    const runOptions: AgentRunOptions = {
      ...options,
      // AgentRunnerV2's contract is streaming. Force the underlying Agent onto its
      // streaming path even when a caller omitted `stream` (or accidentally passed false).
      stream: true,
      onEvent: (event) => {
        queue.push({
          type: "event",
          data: {
            type: event.type as string,
            message: event.message,
            data: event.data,
            timestamp: event.timestamp,
          },
        });
        originalOnEvent?.(event);
      },
      onChunk: (chunk) => {
        queue.push({ type: "chunk", data: { text: chunk } });
        originalOnChunk?.(chunk);
      },
    };

    // Start execution before yielding the first frame. Callback frames that arrive
    // immediately are safely buffered by the queue, while `start` remains the first
    // frame a consumer observes.
    const execution = this.agent
      .run(userInput, runOptions)
      .then((result) => {
        settled = true;
        queue.push({ type: "completion", data: result });
      })
      .catch((error: unknown) => {
        settled = true;
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        queue.push({
          type: "error",
          data: stack ? { message, stack } : { message },
        });
      })
      .finally(() => {
        queue.close();
      });

    try {
      yield {
        type: "start",
        data: {
          conversationId: undefined,
          maxIterations: this.agent["maxIterations"] ?? 50,
        },
      };

      while (true) {
        const next = await queue.next();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      // A consumer breaking out of `for await` means nobody is listening anymore.
      // Stop the underlying run so an in-flight model/tool call does not continue
      // burning time/tokens invisibly. Agent.stop() aborts the active LLM request and
      // causes the normal run loop to settle cleanly.
      if (!settled) {
        this.agent.stop();
      }

      // `execution` already has its own catch above; keep an explicit observer alive
      // after consumer cancellation so a late settlement can never become unhandled.
      void execution;
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
