import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { createCheckpoint } from "./checkpoints.js";
import { summarizeToolCall } from "../tools/tool-summary.js";

/**
 * Filesystem actions that persist a change to disk - the same set the phase-lock hook and the
 * truncation guard (callWouldPersistContent in agent.ts) care about.
 */
const MUTATING_ACTIONS = new Set(["write", "append", "edit", "edit_lines", "delete", "move", "copy"]);

/**
 * Wraps the filesystem tool so every successful mutation gets its OWN checkpoint, instead of
 * only one snapshot per attempt (up to 40 tool-call iterations).
 *
 * Cline's shadow-git checkpoints commit after every file write/terminal command - the coarser
 * per-attempt granularity here meant an attempt that made fifteen edits had exactly one rollback
 * point for all of them; "undo just the edit that broke things" was not possible mid-attempt,
 * only "undo the whole attempt". This closes that gap for file mutations specifically (not shell
 * commands - those already run through their own approval policy, and checkpointing after every
 * `npm install`/`npm test` would multiply checkpoint volume without adding a meaningful rollback
 * point, since those commands don't touch the files being reviewed in the Changes panel).
 *
 * A checkpoint failure (git unavailable, non-fatal per createCheckpoint) never blocks or alters
 * the tool result - checkpoints are a safety net, not a gate, same principle as everywhere else
 * this shadow-git is used.
 */
export function withPerEditCheckpoints(
  fsTool: ToolExecutor,
  sandboxRoot: string | undefined,
  getAttemptLabel: () => string
): ToolExecutor {
  if (!sandboxRoot) return fsTool;
  return {
    ...fsTool,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const result = await fsTool.execute(input);
      if (result.success) {
        const action = String(input["action"] ?? "").toLowerCase();
        if (MUTATING_ACTIONS.has(action)) {
          const label = `${getAttemptLabel()}: ${summarizeToolCall("filesystem", input)}`;
          // Stage only the path(s) this call actually touched instead of the whole tree - see
          // createCheckpoint's doc comment. move/copy touch two paths (source + destination);
          // every other mutating action touches exactly the one in `path`.
          const paths = [input["path"], input["destination"]].filter(
            (value): value is string => typeof value === "string" && value.length > 0
          );
          await createCheckpoint(sandboxRoot, label, paths);
        }
      }
      return result;
    },
  };
}
