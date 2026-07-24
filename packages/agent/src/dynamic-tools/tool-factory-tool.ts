import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { DatabaseService } from "@ducki/database";
import type { Executor } from "../executor/executor.js";
import { buildToolExecutorFromRow, dynamicToolRowToDefinition } from "./dynamic-tool-resolver.js";
import { RESERVED_TOOL_NAMES } from "../tools/reserved-tool-names.js";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

/**
 * Lets any agent/tool/workflow create brand-new callable tools at runtime
 * (sandboxed script execution, reusing the same vm.Script surface as skill
 * `execute`), and later clean up only the tools/tasks it created itself via an
 * explicit `ownerTag` convention (e.g. "workflow:<id>", "tool:<name>:<invocationId>",
 * "agent:coding").
 */
export function createToolFactoryTool(db: DatabaseService, executor: Executor): ToolExecutor {
  return {
    name: "tool_factory",
    description:
      "Register new tools at runtime, list what an owner has created, and clean up tools/tasks that owner no longer needs",
    definition: {
      name: "tool_factory",
      description: "Dynamic tool registration and ownership-scoped cleanup",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["register", "list_owned", "unregister", "cleanup"],
          },
          name: { type: "string", description: "Tool name (register/unregister)" },
          description: { type: "string", description: "Tool description (register)" },
          parameters: { type: "object", description: "JSON-schema-like parameters object (register)" },
          script: { type: "string", description: "JS source executed in a sandboxed vm context; reads `toolInput`/`toolContext`, returns the tool's result (register)" },
          ownerTag: {
            type: "string",
            description: "Owner identifier, e.g. workflow:<id>, tool:<name>:<invocationId>, agent:coding",
          },
          includeTasks: { type: "boolean", description: "Also soft-delete (cancel) tasks owned by ownerTag (cleanup)" },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = String(input["action"] ?? "").toLowerCase();
      const ownerTag = String(input["ownerTag"] ?? "").trim();

      try {
        switch (action) {
          case "register": {
            const name = String(input["name"] ?? "").trim().toLowerCase();
            const description = String(input["description"] ?? "").trim();
            const script = String(input["script"] ?? "");
            const parameters = input["parameters"] && typeof input["parameters"] === "object" ? (input["parameters"] as Record<string, unknown>) : {};

            if (!name || !/^[a-z0-9_-]+$/.test(name)) return fail("tool_factory:register requires a valid field 'name' (lowercase, a-z0-9_-)");
            if (!description) return fail("tool_factory:register requires field 'description'");
            if (!script.trim()) return fail("tool_factory:register requires field 'script'");
            if (!ownerTag) return fail("tool_factory:register requires field 'ownerTag'");
            if (RESERVED_TOOL_NAMES.has(name)) return fail(`tool_factory:register '${name}' collides with a built-in tool name`);

            const existing = await db.getDynamicToolByName(name);
            if (existing) return fail(`tool_factory:register a dynamic tool named '${name}' already exists`);

            const row = await db.createDynamicTool({
              name,
              description,
              parameters: JSON.stringify(parameters),
              script,
              enabled: 1,
              createdBy: ownerTag,
            });

            executor.registerTool(buildToolExecutorFromRow(row));

            return ok({ registered: true, name, ownerTag });
          }

          case "list_owned": {
            if (!ownerTag) return fail("tool_factory:list_owned requires field 'ownerTag'");
            const [tools, tasks] = await Promise.all([
              db.listDynamicTools(ownerTag),
              db.listTasksByOwner(ownerTag),
            ]);
            return ok({
              ownerTag,
              tools: tools.map((row) => dynamicToolRowToDefinition(row)),
              tasks: tasks.map((task) => ({ id: task.id, title: task.title, status: task.status })),
            });
          }

          case "unregister": {
            const name = String(input["name"] ?? "").trim().toLowerCase();
            if (!name) return fail("tool_factory:unregister requires field 'name'");
            if (!ownerTag) return fail("tool_factory:unregister requires field 'ownerTag'");

            const row = await db.getDynamicToolByName(name);
            if (!row) return fail(`tool_factory:unregister no dynamic tool named '${name}'`);
            if (row.createdBy !== ownerTag) return fail(`tool_factory:unregister '${name}' is not owned by '${ownerTag}'`);

            await db.deleteDynamicTool(name);
            executor.unregisterTool(name);
            return ok({ unregistered: true, name });
          }

          case "cleanup": {
            if (!ownerTag) return fail("tool_factory:cleanup requires field 'ownerTag'");
            const includeTasks = input["includeTasks"] === true;

            const ownedTools = await db.listDynamicTools(ownerTag);
            for (const row of ownedTools) {
              executor.unregisterTool(row.name);
            }
            const removedTools = await db.deleteDynamicToolsByOwner(ownerTag);

            let cancelledTasks = 0;
            if (includeTasks) {
              const ownedTasks = await db.listTasksByOwner(ownerTag);
              for (const task of ownedTasks) {
                await db.updateTask(task.id, { status: "cancelled" });
                cancelledTasks++;
              }
            }

            return ok({ cleaned: true, ownerTag, removedTools, cancelledTasks });
          }

          default:
            return fail(`tool_factory: unknown action '${action}'`);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
