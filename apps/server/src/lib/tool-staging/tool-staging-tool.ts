import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { ToolStagingManager } from "./tool-staging-manager.js";

/**
 * Chunk size for a single `read`. Must stay below the agent's per-field truncation
 * limit (truncateLargeStrings uses 4000 chars, see Agent.boundToolResultJson) - a
 * larger chunk would be silently cut off again on its way into the conversation,
 * which is exactly the failure this tool exists to fix.
 */
const DEFAULT_CHUNK = 3000;
const MAX_CHUNK = 3800;

export const TOOL_STAGING_TOOL_NAME = "tool_staging";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

/**
 * Reads back tool responses that were too large to inline.
 *
 * Without this tool the staging pipeline was a dead end: `tool-wrapper` wrote the full
 * response to `storage/tool-staging/` and handed the model a `tool-staging://<id>` URL
 * that nothing could resolve, so the agent answered from the truncated fragment and
 * concluded it was done.
 */
export function createToolStagingTool(getManager: () => ToolStagingManager | undefined): ToolExecutor {
  return {
    name: TOOL_STAGING_TOOL_NAME,
    description:
      "Read the full content of a tool response that was too large to be returned inline. " +
      "Whenever a tool result contains a staging id (marked [FULL RESULT AVAILABLE] or __toolStagingId), " +
      "you MUST read it with this tool before answering - the inline part is only a preview.",
    definition: {
      name: TOOL_STAGING_TOOL_NAME,
      description: "Read, list or delete staged (large) tool responses.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["read", "list", "delete"],
            description: "read=fetch content chunk, list=show available staging ids, delete=free the file",
          },
          id: { type: "string", description: "Staging id (required for read and delete)" },
          offset: {
            type: "number",
            description: "Character offset to start reading from (default 0). Use nextOffset from the previous read.",
          },
          limit: {
            type: "number",
            description: `Characters to read (default ${DEFAULT_CHUNK}, max ${MAX_CHUNK})`,
          },
          search: {
            type: "string",
            description:
              "Optional: return only the parts around matches of this text instead of a sequential chunk. " +
              "Use this to find something specific in a very large response.",
          },
        },
        required: ["action"],
      },
    },

    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const manager = getManager();
      if (!manager) return fail("Tool staging is not available");

      const action = String(input["action"] ?? "read").toLowerCase();

      try {
        if (action === "list") {
          const files = await manager.listStaged();
          return ok({
            count: files.length,
            staged: files.map((file) => {
              const match = /_([0-9a-f-]{36})\.md$/i.exec(file);
              return { file, id: match?.[1] ?? undefined };
            }),
          });
        }

        const id = String(input["id"] ?? "").trim();
        if (!id) return fail(`${TOOL_STAGING_TOOL_NAME}:${action} requires the field 'id'`);

        if (action === "delete") {
          const deleted = await manager.deleteStaged(id);
          return deleted ? ok({ deleted: true, id }) : fail(`Staged response '${id}' not found`);
        }

        if (action !== "read") return fail(`Unknown action '${action}'. Use read, list or delete.`);

        const staged = await manager.getStagedResponse(id);
        if (!staged) {
          return fail(
            `Staged response '${id}' not found or expired. Re-run the original tool call to produce it again.`
          );
        }

        const content = staged.content;
        const total = content.length;
        const limit = Math.min(Math.max(Number(input["limit"]) || DEFAULT_CHUNK, 200), MAX_CHUNK);

        const search = typeof input["search"] === "string" ? input["search"].trim() : "";
        if (search) {
          const matches: Array<{ offset: number; excerpt: string }> = [];
          const needle = search.toLowerCase();
          const haystack = content.toLowerCase();
          let from = 0;
          // Cap the number of excerpts so the combined result still fits the agent's bound.
          while (matches.length < 5) {
            const at = haystack.indexOf(needle, from);
            if (at === -1) break;
            const start = Math.max(0, at - 200);
            matches.push({ offset: at, excerpt: content.slice(start, at + limit / 2) });
            from = at + needle.length;
          }
          return ok({
            id,
            toolName: staged.toolName,
            mode: "search",
            search,
            totalChars: total,
            matchCount: matches.length,
            matches,
            note:
              matches.length === 0
                ? "No match. Read sequentially with action=read and offset to inspect the content."
                : "Excerpts around the first matches. Use action=read with offset for full context.",
          });
        }

        const offset = Math.min(Math.max(Number(input["offset"]) || 0, 0), total);
        const chunk = content.slice(offset, offset + limit);
        const nextOffset = offset + chunk.length;
        const hasMore = nextOffset < total;

        return ok({
          id,
          toolName: staged.toolName,
          totalChars: total,
          offset,
          returnedChars: chunk.length,
          nextOffset: hasMore ? nextOffset : undefined,
          hasMore,
          content: chunk,
          note: hasMore
            ? `${total - nextOffset} characters remaining. Call ${TOOL_STAGING_TOOL_NAME} again with offset=${nextOffset} to continue, or use 'search' to jump to what you need.`
            : `End of content. When you no longer need it, call ${TOOL_STAGING_TOOL_NAME} with action=delete.`,
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
