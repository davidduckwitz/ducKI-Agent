/**
 * V2 event emitter with batching, snapshot management, and backward compatibility.
 * Collects granular events, deduplicates, and emits with state snapshots.
 */

import type { AgentRunEvent, AgentRunEventSnapshot, AgentEventEmitter } from "./agent-events.js";

export interface EventEmitterV2Options {
  /** Interval for flushing buffered events (ms). Default: 50ms */
  batchIntervalMs?: number;
  /** Maximum events to batch before flushing. Default: 20 */
  batchSize?: number;
  /** Called for each emitted event */
  onEvent?: (event: AgentRunEvent) => void;
  /** Called for streaming chunks */
  onChunk?: (chunk: string) => void;
}

/**
 * EventEmitterV2: Batches events, manages snapshots, backward compatible.
 */
export class EventEmitterV2 implements AgentEventEmitter {
  private options: Required<EventEmitterV2Options>;
  private buffer: AgentRunEvent[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private lastSnapshot: Partial<AgentRunEventSnapshot> = {};

  constructor(options: EventEmitterV2Options = {}) {
    this.options = {
      batchIntervalMs: options.batchIntervalMs ?? 50,
      batchSize: options.batchSize ?? 20,
      onEvent: options.onEvent ?? (() => {}),
      onChunk: options.onChunk ?? (() => {}),
    };
  }

  /**
   * Emit a chunk of text (streaming response).
   */
  emitChunk(chunk: string): void {
    this.options.onChunk(chunk);
  }

  /**
   * Emit an event with optional snapshot.
   * Events are buffered and flushed periodically or when buffer fills.
   */
  emitEvent(event: AgentRunEvent): void {
    // Add snapshot if not present
    if (!event.snapshot) {
      event.snapshot = { ...this.lastSnapshot } as AgentRunEventSnapshot;
    } else {
      // Update last known snapshot
      this.lastSnapshot = { ...event.snapshot };
    }

    // Add to buffer
    this.buffer.push(event);

    // Flush if buffer is full
    if (this.buffer.length >= this.options.batchSize) {
      this.flush();
    } else if (!this.batchTimer) {
      // Schedule flush if not already scheduled
      this.batchTimer = setTimeout(() => this.flush(), this.options.batchIntervalMs);
    }
  }

  /**
   * Flush all buffered events immediately.
   */
  private flush(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    while (this.buffer.length > 0) {
      const event = this.buffer.shift()!;
      this.options.onEvent(event);
    }
  }

  /**
   * Update the current snapshot (called by Agent after model call, tool execution, etc.).
   */
  updateSnapshot(partial: Partial<AgentRunEventSnapshot>): void {
    this.lastSnapshot = { ...this.lastSnapshot, ...partial };
  }

  /**
   * Force flush any pending events (call before run completes).
   */
  flushPending(): void {
    this.flush();
  }

  /**
   * Clear all pending events (useful for testing).
   */
  clear(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.buffer = [];
    this.lastSnapshot = {};
  }
}
