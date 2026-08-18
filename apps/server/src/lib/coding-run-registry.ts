import type { CodingAgent } from "@ducki/agent";

/**
 * Tracks CodingAgent instances started from an HTTP route (plugin creation, /api/coding-agent/run)
 * by their conversation id, so the existing chat:stop socket handler - which only knew how to
 * stop agents tied to the sending socket (activeAgentsBySocket) - can also reach one of these.
 * An HTTP-triggered run has no socket of its own to be keyed by, and previously had NO stop path
 * at all: the run just kept going until it finished on its own, with no way to cancel it.
 */
const active = new Map<number, CodingAgent>();

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
