import type { ToolExecutor } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import { getRootLogger } from "@ducki/logger";

const logger = getRootLogger().child("SessionSearchTool");

export function createSessionSearchTool(db: DatabaseService): ToolExecutor {
  return {
    name: "session_search",
    description: "Full-text search across all past conversations to find what was discussed",
    definition: {
      name: "session_search",
      description: "Full-text search across all past conversations to find what was discussed",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: { type: "number", description: "Maximum number of results (1-50, default 10)" },
        },
        required: ["query"],
      },
    },
    execute: async (input: Record<string, unknown>) => {
      const query = String(input["query"] ?? "").trim();
      if (!query) {
        return { success: false, data: null, error: "query is required" };
      }

      const maxResults = Math.min(
        Math.max(1, Number(input["max_results"] ?? 10)),
        50
      );

      try {
        const results = await db.searchSessions(query, maxResults);

        if (results.length === 0) {
          return {
            success: true,
            data: { query, results: [], count: 0 },
          };
        }

        // Group by conversation for readability
        const byConversation = new Map<
          number,
          { name: string; messages: Array<{ role: string; content: string; createdAt: string }> }
        >();

        for (const r of results) {
          if (!byConversation.has(r.conversationId)) {
            byConversation.set(r.conversationId, { name: r.conversationName, messages: [] });
          }
          byConversation.get(r.conversationId)!.messages.push({
            role: r.role,
            content: r.content.slice(0, 1000),
            createdAt: r.createdAt,
          });
        }

        const grouped = [...byConversation.entries()].map(([id, group]) => ({
          conversationId: id,
          conversationName: group.name,
          matchCount: group.messages.length,
          messages: group.messages.slice(0, 5), // Top 5 per conversation
        }));

        return {
          success: true,
          data: {
            query,
            count: results.length,
            conversations: grouped,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("Session search failed", { error: message });
        return { success: false, data: null, error: message };
      }
    },
  };
}