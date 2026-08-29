import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
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
export function createWikiTool(
  getWikiService: () => LlmWikiService | undefined,
  getDb?: () => DatabaseService | undefined
): ToolExecutor {
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
            enum: ["search", "get", "status", "links", "expand"],
            description:
              "search=find entries by query, get=read one entry in full, status=service state, links=list incoming/outgoing wikilinks for a source file (needs sourceFile), expand=spreading-activation traversal of the link graph from a query or seedIds (deeper, bounded neighborhood lookup - use after search, not instead of it)",
          },
          query: { type: "string", description: "Search query (required for action=search; also usable as the seed for action=expand)" },
          id: { type: "number", description: "Numeric entry id for action=get (alternative to sourceFile)" },
          sourceFile: {
            type: "string",
            description: "Relative source file path - required for action=links, and usable instead of 'id' for action=get (e.g. the ids returned by action=expand)",
          },
          seedIds: {
            type: "array",
            items: { type: "string" },
            description: "action=expand only: explicit source-file ids to seed the traversal from, instead of a query",
          },
          maxHops: { type: "number", description: "action=expand only: max hops to traverse (default 2, hard cap 3)" },
          maxNodes: { type: "number", description: "action=expand only: max nodes to return (default 12, hard cap 25)" },
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

        if (action === "links") {
          const db = getDb?.();
          if (!db) return fail("Database is not available for action=links");
          const sourceFile = String(input["sourceFile"] ?? "").trim();
          if (!sourceFile) return fail("wiki:links requires field 'sourceFile'");
          const allLinks = await db.listLlmWikiLinks("active");
          const outgoing = allLinks.filter((link) => link.sourceFile === sourceFile);
          const incoming = allLinks.filter((link) => link.targetFile === sourceFile);

          // Folder membership is a derived structural connection (same directory), not
          // a stored link row - surface it the same way so the agent sees the full
          // picture of what expand() would traverse, not just explicit [[links]].
          const folderPath = sourceFile.includes("/") ? sourceFile.slice(0, sourceFile.lastIndexOf("/")) : null;

          return ok({
            sourceFile,
            folder: folderPath,
            outgoing: outgoing.map((l) => ({ id: l.id, targetRaw: l.targetRaw, targetFile: l.targetFile, origin: l.origin })),
            incoming: incoming.map((l) => ({ id: l.id, sourceFile: l.sourceFile, origin: l.origin })),
            note: folderPath
              ? `Also implicitly connected to every other note under '${folderPath}/' via the folder hub (2 hops apart, use action=expand to reach them).`
              : "Root-level note - no implicit folder connections.",
          });
        }

        if (action === "expand") {
          const rawSeedIds = input["seedIds"];
          const seedIds = Array.isArray(rawSeedIds) ? rawSeedIds.map((s) => String(s)) : undefined;
          const query = typeof input["query"] === "string" ? input["query"] : undefined;
          if ((!seedIds || seedIds.length === 0) && !query?.trim()) {
            return fail("wiki:expand requires either 'query' or 'seedIds'");
          }
          const maxHops = input["maxHops"] !== undefined ? Number(input["maxHops"]) : undefined;
          const maxNodes = input["maxNodes"] !== undefined ? Number(input["maxNodes"]) : undefined;

          const nodes = await wiki.expand({ query, seedIds, maxHops, maxNodes });
          if (nodes.length === 0) {
            return ok({
              nodes: [],
              note: "Nothing reachable from this seed. Try a broader query, or use action=search first to find a starting note.",
            });
          }
          return ok({
            nodes: nodes.map((n) => ({
              id: n.id,
              title: n.title,
              status: n.status,
              tags: n.tags,
              hopDistance: n.hopDistance,
              activation: Number(n.activation.toFixed(3)),
              matchedSeed: n.matchedSeed,
            })),
            note: "Orientation only (no full text). Use wiki action=get with sourceFile=<id> for a specific node's content.",
          });
        }

        if (action === "get") {
          // expand/links/graph identify a note by its sourceFile path, not the numeric
          // chunk id search/get historically used - accept either so expand's output
          // is directly usable without a translation step.
          const sourceFile = typeof input["sourceFile"] === "string" ? input["sourceFile"].trim() : "";
          if (sourceFile) {
            const entries = await wiki.listEntries(3000);
            const chunks = entries
              .filter((item) => item.sourcePath === sourceFile || item.sourcePath.startsWith(`${sourceFile}#chunk-`))
              .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
            if (chunks.length === 0) return fail(`Wiki note '${sourceFile}' not found`);
            return ok({
              sourceFile,
              title: chunks[0]?.title.replace(/\s*\(chunk \d+\/\d+\)$/, ""),
              status: chunks[0]?.status,
              content: chunks.map((c) => c.content).join("\n\n"),
              updatedAt: chunks[0]?.updatedAt,
            });
          }

          const id = Number(input["id"]);
          if (!Number.isFinite(id) || id <= 0) return fail("wiki:get requires a numeric field 'id' or a 'sourceFile'");
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
