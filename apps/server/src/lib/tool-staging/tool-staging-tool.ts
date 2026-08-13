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
          id: {
            type: "string",
            description:
              "Staging id. For 'read' it defaults to the most recently staged response if omitted; " +
              "for 'delete' an id is required unless exactly one staged response exists.",
          },
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

        if (action !== "read" && action !== "delete") {
          return fail(`Unknown action '${action}'. Use read, list or delete.`);
        }

        // Recover from the common small-model slip of calling read/delete without an `id`.
        // For `read` we auto-select the newest staged response (read-only, safe, and almost
        // always the one the staging notice just pointed at). For `delete` we only auto-pick
        // when there is exactly one, otherwise we return the ids so the model can retry.
        let id = String(input["id"] ?? "").trim();
        let autoResolvedFrom: string | undefined;
        if (!id) {
          const staged = await manager.listStagedDetailed();
          if (staged.length === 0) {
            return fail(
              `${TOOL_STAGING_TOOL_NAME}:${action} needs an 'id', but there are no staged responses. ` +
                `The previous tool result was returned inline in full — answer from it directly.`
            );
          }
          if (action === "read" || staged.length === 1) {
            id = staged[0]!.id;
            autoResolvedFrom = staged[0]!.toolName;
          } else {
            const list = staged.slice(0, 10).map((s) => `${s.id} (${s.toolName})`).join(", ");
            return fail(
              `${TOOL_STAGING_TOOL_NAME}:delete needs an 'id'. Available staged ids: ${list}. ` +
                `Call again with the exact id you want to delete.`
            );
          }
        }

        if (action === "delete") {
          const deleted = await manager.deleteStaged(id);
          return deleted ? ok({ deleted: true, id }) : fail(`Staged response '${id}' not found`);
        }

        const staged = await manager.getStagedResponse(id);
        if (!staged) {
          return fail(
            `Staged response '${id}' not found or expired. Re-run the original tool call to produce it again.`
          );
        }

        // When the id was inferred (model omitted it), tell the model which one we picked
        // so it can address the same id explicitly on follow-up chunks.
        const autoNote = autoResolvedFrom
          ? `Auto-selected the most recent staged response (id "${id}" from ${autoResolvedFrom}) because no id was given. `
          : "";

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
              autoNote +
              (matches.length === 0
                ? "No match. Read sequentially with action=read and offset to inspect the content."
                : "Excerpts around the first matches. Use action=read with offset for full context."),
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
          note:
            autoNote +
            (hasMore
              ? `${total - nextOffset} characters remaining. Call ${TOOL_STAGING_TOOL_NAME} again with offset=${nextOffset} to continue, or use 'search' to jump to what you need.`
              : `End of content. When you no longer need it, call ${TOOL_STAGING_TOOL_NAME} with action=delete.`),
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
