import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { diagnosticsTool, invalidateDiagnosticsCache } from "@ducki/tools";

/**
 * Pins the diagnostics tool to the CodingAgent's sandbox.
 *
 * Without this the tool would default to the SERVER process's cwd, so it would happily type-check
 * the wrong project and report a clean bill of health for code it never looked at - the most
 * dangerous possible failure mode for a verification tool. A model-supplied projectRoot is
 * ignored rather than merely defaulted, for the same reason the filesystem tool forces basePath.
 */
export function createScopedDiagnosticsTool(sandboxRoot: string): ToolExecutor {
  const definition = JSON.parse(JSON.stringify(diagnosticsTool.definition)) as typeof diagnosticsTool.definition;
  const properties = definition.parameters?.properties as Record<string, unknown> | undefined;
  if (properties && "projectRoot" in properties) {
    delete properties["projectRoot"];
  }
  definition.description = `${definition.description} Scoped to ${sandboxRoot}.`;

  return {
    name: diagnosticsTool.name,
    description: `${diagnosticsTool.description} (scoped to ${sandboxRoot})`,
    definition,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      return diagnosticsTool.execute({ ...input, projectRoot: sandboxRoot });
    },
  };
}

/**
 * Drops the warm compilers at the start of a run, since files may have been created or deleted
 * outside the agent since the last one and a stale program would report on a file set that no
 * longer exists.
 *
 * Clears ALL of them, not just this sandbox's: the cache is keyed by the governing tsconfig,
 * which a sandbox root cannot be mapped back to (one root can span several configs, and a
 * config outside the root can govern files inside it). Rebuilding costs a few seconds once per
 * run, so the blunt version is the safe one - the parameter is kept only so callers read as
 * intended at the call site.
 */
export function resetDiagnosticsFor(_sandboxRoot: string | undefined): void {
  invalidateDiagnosticsCache();
}
