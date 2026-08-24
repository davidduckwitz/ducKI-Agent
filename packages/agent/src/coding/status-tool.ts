import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { TodoItem } from "./todo-tool.js";

/**
 * Minimal state-gatherer interface – a contract, not a class reference, so the tool does not
 * import CodingAgent itself (which would create a circular dependency). The factory below takes
 * a closure instead of a CodingAgent member function so the tool file stays clean.
 */
export interface StatusProvider {
  /** Absolute project root when sandboxed, undefined otherwise. */
  sandboxRoot: string | undefined;
  /** 1-based attempt counter for the current run. */
  currentAttempt: number;
  /** The phase the model last declared (explore/plan/edit/verify/report/unstarted). */
  currentPhase: string;
  /** Snapshot of every checklist item the agent is steering by. */
  checklistSnapshot(): TodoItem[];
  /**
   * Files that still carry live auto-diagnostics errors after the most recent edit. Empty when
   * no errors are pending or auto-diagnostics itself (tsc) is unavailable.
   */
  pendingDiagnosticErrorsSnapshot(): Array<{ file: string; count: number; errors: string[] }>;
}

/**
 * Answers the question every agent eventually asks: "what did I actually change, and what still
 * needs fixing?" – from the system's own ground-truth records (checklist, phase, diagnostics,
 * checkpoint diff), not from the agent's conversational memory. That matters most when the
 * context window has been trimmed and earlier tool results are no longer visible.
 */
export function createStatusTool(provider: StatusProvider): ToolExecutor {
  return {
    name: "status",
    description: "Run-scoped status snapshot: checklist, phase, diagnostics, and checkpoint diff.",
    definition: {
      name: "status",
      description:
        "Snapshot this coding run's current state. Returns the checklist (with per-step status), " +
        "the current phase, any live diagnostic errors from the last edit, and what files changed. " +
        "Use this to check progress without re-reading files or recounting from conversation " +
        "history – especially after context trimming. Costs one tool call, not N grep/read rounds.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    async execute(_input: Record<string, unknown>): Promise<ToolResult> {
      const data: Record<string, unknown> = {};

      // ── Attempt & Phase ──────────────────────────────────────────────────
      data.attempt = provider.currentAttempt;
      data.phase = provider.currentPhase;

      // ── Checklist ────────────────────────────────────────────────────────
      const items = provider.checklistSnapshot();
      if (items.length > 0) {
        data.checklist = items.map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          ...(item.note ? { note: item.note } : {}),
        }));
        data.openSteps = items.filter(
          (item) => item.status === "pending" || item.status === "in_progress"
        ).length;
      } else {
        data.checklist = [];
        data.openSteps = 0;
      }

      // ── Pending Diagnostics ─────────────────────────────────────────────
      const diagErrors = provider.pendingDiagnosticErrorsSnapshot();
      if (diagErrors.length > 0) {
        data.diagnosticErrors = diagErrors.map((entry) => ({
          file: entry.file,
          count: entry.count,
          sample: entry.errors.slice(0, 5),
        }));
      } else {
        data.diagnosticErrors = [];
      }

      // ── Diff (checkpoint-aware, only when sandboxed) ─────────────────────
      // Avoid importing checkpoints at the top level – lazy-load so a non-
      // sandboxed run never touches the checkpoint module at all.
      const sb = provider.sandboxRoot;
      if (sb) {
        try {
          const { listCheckpoints, diffCheckpoint } = await import("./checkpoints.js");
          const checkpoints = await listCheckpoints(sb, 10);
          const latest = checkpoints[0];
          data.totalCheckpoints = checkpoints.length;
          if (latest) {
            const diff = await diffCheckpoint(sb, latest.sha);
            if (diff) {
              data.changedFiles = diff.files.map((f) => ({
                path: f.path,
                added: f.added,
                removed: f.removed,
                status: f.status,
              }));
              data.totalChanges = diff.files.length;
              // Offer just the summary rather than the whole patch – the model can
              // read individual files with the filesystem tool when detail is needed.
              if (diff.truncated) data.diffTruncated = true;
            } else {
              data.changedFiles = [];
              data.totalChanges = 0;
            }
          } else {
            data.changedFiles = [];
            data.totalChanges = 0;
            data.checkpointNote = "No checkpoint found yet – no edits have been snapshotted.";
          }
        } catch {
          data.changedFiles = [];
          data.totalChanges = 0;
          data.checkpointError =
            "Could not read checkpoint diff (git unavailable or checkpoint repo missing).";
        }
      } else {
        data.changedFiles = [];
        data.totalChanges = 0;
        data.checkpointNote = "No sandbox – checkpoint diff is unavailable.";
      }

      return { success: true, data };
    },
  };
}
