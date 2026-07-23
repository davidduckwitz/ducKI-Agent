
import { EventEmitter } from "events";

class RingBuffer<T> {
  private buffer: Array<T | undefined>;
  private head = 0;
  private tail = 0;
  private size = 0;

  constructor(private maxSize: number) {
    this.buffer = new Array(maxSize);
  }

  push(item: T): void {
    if (this.size === this.maxSize) {
      this.head = (this.head + 1) % this.maxSize;
    } else {
      this.size++;
    }
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.maxSize;
  }

  shift(): T | undefined {
    if (this.size === 0) return undefined;
    const item = this.buffer[this.head];
    this.head = (this.head + 1) % this.maxSize;
    this.size--;
    return item;
  }

  getSize(): number {
    return this.size;
  }

  isFull(): boolean {
    return this.size === this.maxSize;
  }
}

/**
 * @class EventBus
 * @description A central pub/sub mechanism for decoupling components.
 */
export class EventBus extends EventEmitter {
  /**
   * Publishes an event on the bus.
   * @param eventName The name of the event to emit.
   * @param payload Data associated with the event.
   */
  // --- Async Streaming Implementation ---
  private eventQueue: RingBuffer<{ name: string; payload: any }> = new RingBuffer(10000);
  private activeIterators: Map<string, Generator<any>> = new Map();

  /**
   * Returns an async iterator for consuming events asynchronously .
   * @returns {AsyncGenerator<T>} An asynchronous iterable stream from LLMStream of published payloads.
   */
  public async *stream(): AsyncGenerator<any> {
    // Wait until the queue has items or a new event is manually pushed.
    while (true) {
      yield await new Promise(resolve => {
        const listener = () => resolve(this.eventQueue.shift());
        this.on('EVENT_PUSH', listener);
      });
    }
  }

  /**
   * Publishes an event on the bus and queues it for asynchronous iteration.
   */
  public publish<T>(eventName: string, payload: T): void {
    // 1. Emit synchronously to existing listeners
    this.emit(eventName, payload);

    // 2. Add to queue for async consumers
    const isFull = this.eventQueue.isFull();
    this.eventQueue.push({ name: eventName, payload });

    if (isFull && this.eventQueue.getSize() > 9000) {
      console.warn('[EventBus] Event queue overflow detected - dropping oldest events');
    }

    // Signal the generator that new data is available
    this.emit('EVENT_PUSH');
  }


  /**
   * Subscribes a listener function to a specific event name.
   * @param eventName The name of the event to listen for.
   * @param listener The function to execute when the event is published.
   */
  public subscribe<T>(eventName: string, listener: (payload: T) => void): () => void {
    const subscription = this.on(eventName, listener);
    // Return an unsubscribe function for convenience
    return () => this.removeListener(eventName, listener);
  }
}

/**
 * Factory method to create a singleton instance of the EventBus.
 */
export const eventBus = new EventBus();