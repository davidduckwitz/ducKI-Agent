import type { DatabaseService } from "@ducki/database";

/**
 * Shared upsert-by-prefix mechanism for "guaranteed-present" memories: a memory tagged
 * with a unique prefix, importance-boosted so it reliably lands in `buildSystemContext`'s
 * top-8 cut instead of competing with ordinary memories. Originally built for the single
 * agent-behavior/human-info profile blobs (apps/server/src/routes/memory.ts); the wiki
 * "Befehl"-tag feature (llm-wiki-service.ts) reuses it per-note via a per-file prefix
 * instead of one global one.
 */

export function prefixedContent(prefix: string, content: string): string {
  return `${prefix} ${content.trim()}`.trim();
}

export function extractPrefixed(content: string, prefix: string): string {
  return content.startsWith(prefix) ? content.slice(prefix.length).trim() : "";
}

export async function findByPrefix(db: DatabaseService, type: string, prefix: string) {
  const entries = await db.getMemories(undefined, type);
  return entries.filter((entry) => entry.content.startsWith(prefix));
}

/** Empty `content` deletes any existing entry for this prefix without writing a new one. */
export async function upsertProfileEntry(
  db: DatabaseService,
  type: "long-term" | "semantic",
  prefix: string,
  content: string,
  importance: number
): Promise<void> {
  const existing = await findByPrefix(db, type, prefix);
  for (const entry of existing) {
    await db.deleteMemory(entry.id);
  }
  const normalized = content.trim();
  if (!normalized) return;
  await db.addMemory({
    type,
    content: prefixedContent(prefix, normalized),
    importance,
  });
}
