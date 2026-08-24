import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { runDiagnostics } from "@ducki/tools";
import { isAbsolute, resolve } from "node:path";

/** File types the diagnostics layer can actually say something meaningful about. */
const CHECKABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/i;

/** Actions that change a file's content. A move/copy/delete changes the file SET, which the
 *  language service picks up on the next real check anyway. */
const MUTATING_ACTIONS = new Set(["write", "edit", "append"]);

/** Actions that relocate a file. The source and/or destination may need diagnostics. */
const RELOCATING_ACTIONS = new Set(["move", "copy"]);

/** All actions that could affect diagnostics — mutating or relocating. */
const DIAGNOSTICABLE_ACTIONS = new Set([...MUTATING_ACTIONS, ...RELOCATING_ACTIONS]);

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
      if (!DIAGNOSTICABLE_ACTIONS.has(action)) return result;

      const rawPath = typeof input["path"] === "string" ? input["path"] : "";

      // Collect every path this action touches. For write/edit/append it is just the target
      // file. For move/copy both source and destination matter: the source may have been
      // imported elsewhere (those files now need to find it at the new name), and the
      // destination file itself must be type-checked. A rename without checking both is like
      // an edit without verification - the error stays invisible until the full build.
      const affectedPaths: string[] = [];
      if (rawPath && CHECKABLE.test(rawPath)) affectedPaths.push(rawPath);
      if (RELOCATING_ACTIONS.has(action)) {
        const dest = typeof input["destination"] === "string" ? input["destination"] : "";
        if (dest && CHECKABLE.test(dest) && dest !== rawPath) affectedPaths.push(dest);
      }
      if (affectedPaths.length === 0) return result;

      const absolutes = affectedPaths.map((p) => isAbsolute(p) ? resolve(p) : resolve(sandboxRoot, p));

      try {
        const { diagnostics, checkers } = runDiagnostics(sandboxRoot, absolutes);
        const errors = diagnostics.filter((d) => d.severity === "error");

        // Nothing to say is worth saying explicitly here: it tells the model the edit is
        // confirmed good, which is what stops it from "verifying" by re-reading the file.
        if (errors.length === 0) {
          const files = affectedPaths.length === 1 ? affectedPaths[0]! : affectedPaths.join(", ");
          return {
            ...result,
            data: {
              ...(typeof result.data === "object" && result.data !== null ? result.data : { path: rawPath }),
              diagnostics: {
                ok: true,
                errorCount: 0,
                checkedFiles: affectedPaths,
                summary: `No type or syntax errors in ${files}.`,
              },
            },
          };
        }

        // Group errors by file so the model knows exactly which path is bad.
        const byFile = new Map<string, typeof errors>();
        for (const e of errors) {
          const group = byFile.get(e.file) ?? [];
          group.push(e);
          byFile.set(e.file, group);
        }
        const perFile = [...byFile.entries()].map(([file, errs]) => `${file}: ${errs.length} error(s)`).join("; ");

        return {
          ...result,
          data: {
            ...(typeof result.data === "object" && result.data !== null ? result.data : { path: rawPath }),
            diagnostics: {
              ok: false,
              errorCount: errors.length,
              checkers,
              checkedFiles: affectedPaths,
              // Capped: a single bad edit can cascade into hundreds of errors, and the first
              // handful are the ones that actually caused it.
              errors: errors.slice(0, 15).map((d) => `${d.file}:${d.line}:${d.column} ${d.code ?? ""} ${d.message}`.trim()),
              ...(errors.length > 15 ? { note: `${errors.length - 15} further error(s) not listed.` } : {}),
              summary:
                `This ${action} left ${errors.length} error(s): ${perFile}. Fix them now - do not move on ` +
                `to another file and do not run the full build until these files are clean.`,
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
