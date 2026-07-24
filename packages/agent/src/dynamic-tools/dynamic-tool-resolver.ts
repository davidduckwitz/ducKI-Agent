import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { DatabaseService, DynamicToolSelect } from "@ducki/database";
import { runScriptInSandbox } from "@ducki/tools";
import type { DynamicToolResolver } from "../executor/executor.js";

function parseParameters(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function dynamicToolRowToDefinition(row: DynamicToolSelect): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  return {
    name: row.name,
    description: row.description,
    parameters: parseParameters(row.parameters),
  };
}

export function buildToolExecutorFromRow(row: DynamicToolSelect): ToolExecutor {
  const parameters = parseParameters(row.parameters);
  return {
    name: row.name,
    description: row.description,
    definition: {
      name: row.name,
      description: row.description,
      parameters,
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      try {
        const executed = runScriptInSandbox(
          row.script,
          { input, context: {} },
          { inputVar: "toolInput", contextVar: "toolContext" }
        );
        return {
          success: true,
          data: { result: executed.result ?? null, logs: executed.logs },
        };
      } catch (error) {
        return {
          success: false,
          data: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/**
 * Builds a lazy resolver an Executor can fall back on when a tool name isn't in
 * its in-memory map. Executors are recreated per request, so this DB-backed
 * lookup is what lets a tool registered by an earlier run still be callable.
 */
export function createDynamicToolResolver(db: DatabaseService): DynamicToolResolver {
  return async (name: string): Promise<ToolExecutor | undefined> => {
    const row = await db.getDynamicToolByName(name);
    if (!row || !row.enabled) return undefined;
    return buildToolExecutorFromRow(row);
  };
}
