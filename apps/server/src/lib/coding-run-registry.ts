import type { CodingAgent } from "@ducki/agent";

/**
 * Tracks CodingAgent instances started from an HTTP route (plugin creation, /api/coding-agent/run)
 * by their conversation id, so the existing chat:stop socket handler - which only knew how to
 * stop agents tied to the sending socket (activeAgentsBySocket) - can also reach one of these.
 * An HTTP-triggered run has no socket of its own to be keyed by, and previously had NO stop path
 * at all: the run just kept going until it finished on its own, with no way to cancel it.
 */
const active = new Map<number, CodingAgent>();

/**
 * Per-conversation run lock, separate from `active` above: `active` is only populated once
 * CodingAgent.run() has gotten far enough to call onConversationStarted (async, after project
 * resolution etc.), which leaves a window where two near-simultaneous HTTP POST /coding-agent/run
 * requests for the SAME conversationId (a fast double-submit before the UI can react, or a
 * network retry) both see "nothing running yet" and both proceed - producing duplicate runs with
 * competing file edits and duplicate transcript messages. This set is acquired synchronously at
 * the very top of the route handler, before any await, so the check-and-set is atomic.
 */
const locked = new Set<number>();

/**
 * Runs that stream into their conversation's chat room (chat:start ... chat:complete/chat:error/
 * chat:stopped) - the /coding-agent/run route. Plugin-creation runs are tracked in `active` too
 * but report through plugin_create_* events instead, so a client must not be told such a
 * conversation is "running": nothing would ever clear that loading state again.
 */
const streamingToChat = new Set<number>();

export function registerCodingRun(
  conversationId: number,
  agent: CodingAgent,
  options?: { streamsToChat?: boolean }
): void {
  active.set(conversationId, agent);
  if (options?.streamsToChat) streamingToChat.add(conversationId);
}

export function unregisterCodingRun(conversationId: number): void {
  active.delete(conversationId);
  streamingToChat.delete(conversationId);
}

/** Returns true if a tracked run was found and told to stop. */
export function stopCodingRun(conversationId: number): boolean {
  const agent = active.get(conversationId);
  if (!agent) return false;
  agent.stop();
  return true;
}

/** Atomically claims the run lock for a conversation. False means a run is already in
 *  progress for it - the caller must not start a second one. */
export function acquireCodingRunLock(conversationId: number): boolean {
  if (locked.has(conversationId)) return false;
  locked.add(conversationId);
  return true;
}

/** Releases a lock acquired via {@link acquireCodingRunLock}. Always call from a `finally`. */
export function releaseCodingRunLock(conversationId: number): void {
  locked.delete(conversationId);
}

/** True while any CodingAgent run owns this conversation - locked by the route (possibly still
 *  validating) or already running (route or plugin creation). Used to refuse a parallel run. */
export function isCodingRunBusy(conversationId: number): boolean {
  return locked.has(conversationId) || active.has(conversationId);
}

/** True once a chat-streaming CodingAgent run has started on this conversation: it has emitted
 *  chat:start and is guaranteed to end with chat:complete/chat:error/chat:stopped. */
export function isCodingRunStreaming(conversationId: number): boolean {
  return streamingToChat.has(conversationId);
}

/** Conversation ids with a started chat-streaming CodingAgent run (socket hello snapshot). */
export function streamingCodingRunIds(): number[] {
  return Array.from(streamingToChat);
}

/**
 * Conversations with a generic WebSocket chat run in flight. The WS handler and the CodingAgent
 * HTTP route used to guard only against themselves, so a WS message sent while a coding run was
 * active (or the other way round) started a second agent on the SAME conversation - both writing
 * into one transcript and possibly the same files. Each side now checks the other's state.
 * Check-and-set happens synchronously on both sides, so there is no await window between them.
 */
const chatRuns = new Set<number>();

export function markChatRun(conversationId: number): void {
  chatRuns.add(conversationId);
}

export function unmarkChatRun(conversationId: number): void {
  chatRuns.delete(conversationId);
}

export function isChatRunActive(conversationId: number): boolean {
  return chatRuns.has(conversationId);
}
