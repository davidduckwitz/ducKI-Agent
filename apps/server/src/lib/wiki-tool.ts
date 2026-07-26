import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { LlmWikiService } from "./llm-wiki-service.js";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

/**
 * Native wiki tool.
 *
 * Until now the LLM-Wiki was only reachable through the generic `http` tool against
 * `/api/wiki/search` - which required the agent to know the server's own scheme, host and
 * port and to hand-build a query string, for a service running in the very same process.
 * Any mistake in that URL looked to the agent like "the wiki has nothing", which is why
 * it fell back to answering from its own weights instead of the knowledge base.
 *
 * Takes a getter rather than the service instance because the wiki service is constructed
 * after the agent factory (and could be replaced on reload) - same pattern as the
 * provider ref used elsewhere in the bootstrap.
 */
export function createWikiTool(getWikiService: () => LlmWikiService | undefined): ToolExecutor {
  return {
    name: "wiki",
    description:
      "Search the internal LLM wiki (knowledge base) for existing project knowledge, conventions, docs and previously learned facts. Use this BEFORE answering from general knowledge whenever the question touches internal or project-specific information.",
    definition: {
      name: "wiki",
      description: "Search and inspect the internal LLM wiki knowledge base.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["search", "get", "status"],
            description: "search=find entries by query, get=read one entry in full, status=service state",
          },
          query: { type: "string", description: "Search query (required for action=search)" },
          id: { type: "number", description: "Entry id (required for action=get)" },
          limit: { type: "number", description: "Max results for search (default 5)" },
          includeCandidates: {
            type: "boolean",
            description: "Also return unmoderated 'candidate' entries. Mark them as preliminary when used.",
          },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const wiki = getWikiService();
      if (!wiki) return fail("Wiki service is not available");

      const action = String(input["action"] ?? "search").toLowerCase();

      try {
        if (action === "status") {
          return ok(wiki.getStats());
        }

        if (action === "get") {
          const id = Number(input["id"]);
          if (!Number.isFinite(id) || id <= 0) return fail("wiki:get requires a numeric field 'id'");
          const entries = await wiki.listEntries(3000);
          const entry = entries.find((item) => item.id === id);
          if (!entry) return fail(`Wiki entry ${id} not found`);
          return ok({
            id: entry.id,
            title: entry.title,
            sourcePath: entry.sourcePath,
            status: entry.status,
            content: entry.content,
            updatedAt: entry.updatedAt,
          });
        }

        const query = String(input["query"] ?? "").trim();
        if (!query) return fail("wiki:search requires field 'query'");

        const limitRaw = Number(input["limit"] ?? 5);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, Math.floor(limitRaw))) : 5;
        const includeCandidates = input["includeCandidates"] === true;

        const results = await wiki.search(query, limit, includeCandidates);
        if (results.length === 0) {
          // Say so explicitly: an empty array is easy for a model to read as "the tool
          // failed", which invites it to invent an answer instead of reporting a gap.
          return ok({
            query,
            count: 0,
            results: [],
            note: "No wiki entry matched. Say so instead of guessing, or answer from general knowledge and label it as such.",
          });
        }

        return ok({
          query,
          count: results.length,
          results: results.map((entry) => ({
            id: entry.id,
            title: entry.title,
            sourcePath: entry.sourcePath,
            status: entry.status,
            score: Number(entry.score.toFixed(3)),
            excerpt: entry.contentPreview,
            updatedAt: entry.updatedAt,
          })),
          note: "Cite sourcePath/title when using these. Use wiki action=get for an entry's full text.",
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
