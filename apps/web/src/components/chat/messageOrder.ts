import type { AgentEventType, RenderedChatMessage } from "./chatTypes";

export function normalizeMessageForDedup(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

export function buildEventDedupKey(
  eventType: AgentEventType | undefined,
  content: string,
  timestamp: string
): string {
  const normalizedType = eventType ?? "unknown";
  const normalizedContent = normalizeMessageForDedup(content);
  const ts = Date.parse(timestamp);
  // Bucket by second to avoid millisecond drift between live/persisted paths.
  const secondBucket = Number.isFinite(ts) ? Math.floor(ts / 1000) : timestamp;
  return `${normalizedType}|${normalizedContent}|${secondBucket}`;
}

/** What the merge knows about the conversation's persisted rows. */
export interface PersistedIndex {
  /** Rendered ids ("db-42") of every persisted row. */
  ids: Set<string>;
  /** Dedup keys of persisted event rows. */
  eventKeys: Set<string>;
  /**
   * `displayMessageId`s of stored agent-text rows. These are exact, server-assigned ids for a
   * specific block of text, so matching one is a fact rather than the guess every other rule
   * here has to make.
   */
  displayIds: Set<string>;
  /**
   * Persisted `localMessageId`s bucketed BY ROLE. The id identifies the turn, not the message -
   * the agent stamps the same one on the user row, on every assistant row and on every event
   * row - so it must only ever be compared against a persisted row of the same role.
   */
  turnIdsByRole: Map<string, Set<string>>;
}

/**
 * Index the persisted history for dedup.
 *
 * Takes the RENDERED view, not the raw database rows, and that distinction is the whole reason
 * this function exists. Mapping a row can change its role: an assistant row whose text still
 * carries `[TOOL:...]` markers is re-mapped into a tool_call *event* box. Indexing the raw rows
 * registered such a row under "assistant", so the local reply was dropped as "already stored"
 * while nothing actually rendered as an assistant message - the reply just disappeared. The
 * agent writes one assistant row per iteration before running that iteration's tools, so the
 * very first one was enough to delete the final answer.
 */
export function buildPersistedIndex(rendered: RenderedChatMessage[]): PersistedIndex {
  const ids = new Set<string>();
  const eventKeys = new Set<string>();
  const displayIds = new Set<string>();
  const turnIdsByRole = new Map<string, Set<string>>();

  for (const m of rendered) {
    ids.add(m.id);

    const displayId = m.metadata?.["displayMessageId"] as string | undefined;
    if (displayId) displayIds.add(displayId);

    const localId = m.metadata?.["localMessageId"] as string | undefined;
    if (localId) {
      const bucket = turnIdsByRole.get(m.role) ?? new Set<string>();
      bucket.add(localId);
      turnIdsByRole.set(m.role, bucket);
    }

    if (m.role === "event") {
      eventKeys.add(buildEventDedupKey(m.eventType, m.content, m.timestamp));
    }
  }

  return { ids, eventKeys, displayIds, turnIdsByRole };
}

/**
 * True when a local (not yet persisted) message is already represented in the database and can
 * be dropped from the merge.
 *
 * The role bucketing is the whole point. Checking the turn id alone deleted the agent's reply
 * as soon as *any* row of that turn was written - and the user row plus the run's events land
 * long before the assistant row does. The reply appeared and was wiped by the very next merge,
 * coming back only after switching chats (which refetches from the database).
 */
export function isSupersededByPersisted(
  message: RenderedChatMessage,
  index: PersistedIndex
): boolean {
  if (message.role === "event") {
    return index.eventKeys.has(
      buildEventDedupKey(message.eventType, message.content, message.timestamp)
    );
  }

  if (index.ids.has(message.id)) return true;

  // Agent text carries an exact id for that specific block, so it needs none of the guesswork
  // below - and must not be subjected to it either: several blocks of one turn share a turn id.
  const displayMessageId = message.metadata?.["displayMessageId"] as string | undefined;
  if (displayMessageId) return index.displayIds.has(displayMessageId);

  const localMessageId = (message.metadata?.["localMessageId"] as string | undefined) ?? message.id;
  const serverMessageId = message.metadata?.["serverMessageId"] as string | undefined;
  const turnKey = localMessageId || serverMessageId;
  if (turnKey && index.turnIdsByRole.get(message.role)?.has(turnKey)) return true;

  return false;
}

/** Row id of a persisted message ("db-42" -> 42), or undefined for a local one. */
export function persistedRowId(id: string): number | undefined {
  if (!id.startsWith("db-")) return undefined;
  const parsed = Number(id.slice(3));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Timeline order for the chat transcript.
 *
 * Stored rows are ordered by row id, which IS the sequence: the database assigns it on insert,
 * and the agent writes its rows through one queue, so the ids run in the order things actually
 * happened. Everything the run produces - the user turn, each block of agent text, every tool
 * event - is a row, so the ordering question is settled by the writer rather than reconstructed
 * by the reader.
 *
 * This deliberately no longer sorts stored rows by timestamp. Doing so mixed clocks (server
 * emit time, database insert time, and at one point the browser's own clock) and left ties
 * whenever a turn emitted several events in the same millisecond - which the old tie-break then
 * resolved by comparing ids as *text*, putting "db-100" ahead of "db-98".
 *
 * Local messages are, by definition, not written yet, so they sort after every stored row and
 * among themselves by timestamp (ties keep arrival order via the stable sort).
 */
export function compareMessages(a: RenderedChatMessage, b: RenderedChatMessage): number {
  const aRow = persistedRowId(a.id);
  const bRow = persistedRowId(b.id);

  if (aRow !== undefined && bRow !== undefined) return aRow - bRow;
  if (aRow !== undefined) return -1;
  if (bRow !== undefined) return 1;

  const aTime = Date.parse(a.timestamp);
  const bTime = Date.parse(b.timestamp);
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
    return aTime - bTime;
  }

  return 0;
}
