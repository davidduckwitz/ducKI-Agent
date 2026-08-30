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

export function registerCodingRun(conversationId: number, agent: CodingAgent): void {
  active.set(conversationId, agent);
}

export function unregisterCodingRun(conversationId: number): void {
  active.delete(conversationId);
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
