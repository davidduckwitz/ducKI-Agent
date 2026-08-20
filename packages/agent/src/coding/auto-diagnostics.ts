import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { runDiagnostics } from "@ducki/tools";
import { isAbsolute, resolve } from "node:path";

/** File types the diagnostics layer can actually say something meaningful about. */
const CHECKABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/i;

/** Actions that change a file's content. A move/copy/delete changes the file SET, which the
 *  language service picks up on the next real check anyway. */
const MUTATING_ACTIONS = new Set(["write", "edit", "append"]);

function autoDiagnosticsEnabled(): boolean {
  const flag = (process.env["DUCKI_CODING_AUTO_DIAGNOSTICS"] ?? "").trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "off" || flag === "no");
}

/**
 * Wraps the filesystem tool so every successful content change is immediately type-checked and
 * the result comes back attached to the write itself.
 *
 * This is the behaviour that separates a coding agent that converges from one that does not.
 * Previously a broken edit stayed invisible until the whole attempt finished and the full build
 * ran - so a single missing import cost an entire attempt (dozens of LLM calls) before the agent
 * even learned something was wrong. Now the very same tool call that introduced the error reports
 * it, in the same turn, with the file and line, while the agent still has all the context it
 * needs to fix it.
 *
 * Deliberately attached to the tool rather than to a lifecycle hook: hooks passed to Agent are
 * all registered under beforeTool, so an afterTool hook would silently never run - and a
 * verification step that silently does not run is worse than none at all.
 */
export function withAutoDiagnostics(fsTool: ToolExecutor, sandboxRoot: string | undefined): ToolExecutor {
  if (!sandboxRoot) return fsTool;

  return {
    name: fsTool.name,
    description: fsTool.description,
    definition: fsTool.definition,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const result = await fsTool.execute(input);

      if (!autoDiagnosticsEnabled()) return result;
      if (!result.success) return result;

      const action = String(input["action"] ?? "").toLowerCase();
      if (!MUTATING_ACTIONS.has(action)) return result;

      const rawPath = typeof input["path"] === "string" ? input["path"] : "";
      if (!rawPath || !CHECKABLE.test(rawPath)) return result;

      const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(sandboxRoot, rawPath);

      try {
        const { diagnostics, checkers } = runDiagnostics(sandboxRoot, [absolute]);
        const errors = diagnostics.filter((d) => d.severity === "error");

        // Nothing to say is worth saying explicitly here: it tells the model the edit is
        // confirmed good, which is what stops it from "verifying" by re-reading the file.
        if (errors.length === 0) {
          return {
            ...result,
            data: {
              ...(typeof result.data === "object" && result.data !== null ? result.data : { path: rawPath }),
              diagnostics: { ok: true, errorCount: 0, summary: "No type or syntax errors in this file." },
            },
          };
        }

        return {
          ...result,
          data: {
            ...(typeof result.data === "object" && result.data !== null ? result.data : { path: rawPath }),
            diagnostics: {
              ok: false,
              errorCount: errors.length,
              checkers,
              // Capped: a single bad edit can cascade into hundreds of errors, and the first
              // handful are the ones that actually caused it.
              errors: errors.slice(0, 15).map((d) => `${d.file}:${d.line}:${d.column} ${d.code ?? ""} ${d.message}`.trim()),
              ...(errors.length > 15 ? { note: `${errors.length - 15} further error(s) not listed.` } : {}),
              summary:
                `This edit left ${errors.length} error(s) in ${rawPath}. Fix them now - do not move on ` +
                `to another file and do not run the full build until this file is clean.`,
            },
          },
        };
      } catch {
        // Diagnostics are an accelerator, never a gate: if the checker cannot run (no tsconfig,
        // no typescript, an exotic project layout), the write still succeeded and the run
        // continues exactly as it did before.
        return result;
      }
    },
  };
}
