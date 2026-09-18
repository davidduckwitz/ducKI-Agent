import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import { extractKeywords } from "@ducki/shared";
import type { LlmWikiService } from "./llm-wiki-service.js";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

/**
 * Combined lookup across the two "what do you know about X" stores: persistent `memory`
 * (short facts/preferences/learnings, keyword-scored SQLite rows) and the `wiki` knowledge
 * base (curated markdown notes with a link graph, same keyword-scoring primitive under the
 * hood). Both already answer overlapping questions via near-identical relevance scoring, but
 * today the model has no way to know upfront which store holds the answer, so a thorough
 * answer costs a `memory` call plus up to three sequential `wiki` calls (search, maybe a
 * broader search, maybe expand). This tool runs both searches in parallel and returns them
 * side by side in ONE call - the common case ("what do you remember about my car") no longer
 * needs a call-count guessing game.
 *
 * Deliberately does NOT blend memory and wiki hits into one fake unified ranking: the two
 * scores (keyword-relevance + importance + recency for memory, keyword-relevance for wiki)
 * are not on a comparable scale, and pretending otherwise would misrepresent confidence.
 * Callers still use `memory` action=query/list or `wiki` action=get/expand for anything
 * beyond this first-pass discovery (full text, editing, graph traversal).
 */
export function createRecallTool(
  db: DatabaseService,
  getWikiService: () => LlmWikiService | undefined
): ToolExecutor {
  return {
    name: "recall",
    description:
      "Search BOTH persistent memory (facts/preferences/learnings) AND the internal wiki knowledge base in a single call. Use this FIRST for 'what do you know/remember about X' questions instead of calling memory and wiki separately - only fall back to those directly for full text, editing, or graph traversal (wiki action=expand).",
    definition: {
      name: "recall",
      description: "Combined discovery search across persistent memory and the wiki knowledge base.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look up, in natural language." },
          limit: { type: "number", description: "Max results per source, default 5 (max 10)." },
        },
        required: ["query"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const query = String(input["query"] ?? "").trim();
      if (!query) return fail("recall requires field 'query'");

      const limitRaw = Number(input["limit"] ?? 5);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10, Math.floor(limitRaw))) : 5;
      const keywords = extractKeywords(query);

      const memoryPromise = (async () => {
        try {
          // No explicit target/type here (this is discovery, not a scoped query) - search
          // both long-term and semantic (the type every llm-wiki-derived memory uses),
          // same default the `memory` tool itself falls back to for an unscoped query.
          const pools = await Promise.all(
            ["long-term", "semantic"].map((type) =>
              db.searchMemories(keywords.length > 0 ? keywords : [query], undefined, type, undefined, limit)
            )
          );
          const seen = new Set<number>();
          const merged = pools.flat().filter((entry) => {
            if (seen.has(entry.id)) return false;
            seen.add(entry.id);
            return true;
          });
          return merged.slice(0, limit).map((entry) => ({
            id: entry.id,
            type: entry.type,
            importance: entry.importance,
            content: entry.content,
            createdAt: entry.createdAt,
          }));
        } catch {
          return [];
        }
      })();

      const wikiPromise = (async () => {
        const wiki = getWikiService();
        if (!wiki) return [];
        try {
          const results = await wiki.search(query, limit, false);
          return results.map((entry) => ({
            id: entry.id,
            title: entry.title,
            sourcePath: entry.sourcePath,
            score: Number(entry.score.toFixed(3)),
            preview: entry.contentPreview,
            updatedAt: entry.updatedAt,
          }));
        } catch {
          return [];
        }
      })();

      const [memoryResults, wikiResults] = await Promise.all([memoryPromise, wikiPromise]);

      if (memoryResults.length === 0 && wikiResults.length === 0) {
        return ok({
          query,
          memory: { count: 0, entries: [] },
          wiki: { count: 0, results: [] },
          note: "Nothing found in memory or the wiki for this query. Say so instead of guessing, or answer from general knowledge and label it as such.",
        });
      }

      return ok({
        query,
        memory: { count: memoryResults.length, entries: memoryResults },
        wiki: { count: wikiResults.length, results: wikiResults },
        note:
          "Two separate result sets, not a blended ranking (different scoring scales). " +
          "Use memory action=query/list for more memory detail, or wiki action=get/expand for full wiki text or the link graph.",
      });
    },
  };
}
