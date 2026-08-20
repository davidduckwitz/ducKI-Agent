import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitCompare, History, RotateCcw } from "lucide-react";
import { api } from "../../lib/api";
import { PanelEmpty } from "../ui/panel";
import { toastManager } from "../../lib/toast";

interface Checkpoint {
  sha: string;
  label: string;
  createdAt: string;
}

/** Colours one diff line. Deliberately not a full syntax highlighter - in a review the only
 *  thing that has to be instantly readable is which side of the change a line is on. */
function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground";
  if (line.startsWith("@@")) return "text-primary";
  if (line.startsWith("+")) return "text-emerald-500";
  if (line.startsWith("-")) return "text-red-500";
  if (line.startsWith("diff --git")) return "text-foreground font-semibold";
  return "text-muted-foreground";
}

function formatTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * Review surface for what a coding run actually did.
 *
 * Before this, a run rewrote real files and the only trace was the result text the agent wrote
 * about itself - the user had to take its word for it, and the sole undo was the filesystem
 * tool's single-level .bak, which the next write to the same file destroys. Here every attempt's
 * pre-state is a checkpoint: pick one, see the exact diff against the current files, and roll
 * back to it if the run went the wrong way.
 */
export function CodingChangesPanel({
  project,
  onOpenFile,
  refreshKey,
}: {
  project: string;
  onOpenFile?: (path: string) => void;
  /** Bumped by the parent when a run finishes, so the list refetches without polling. */
  refreshKey?: number;
}) {
  const queryClient = useQueryClient();
  const [selectedSha, setSelectedSha] = useState<string | null>(null);

  const checkpointsQuery = useQuery({
    queryKey: ["coding", "checkpoints", project, refreshKey],
    queryFn: () => api.coding.listCheckpoints(project),
    enabled: Boolean(project),
  });

  const checkpoints: Checkpoint[] = useMemo(
    () => checkpointsQuery.data?.checkpoints ?? [],
    [checkpointsQuery.data]
  );

  const diffQuery = useQuery({
    queryKey: ["coding", "checkpoint-diff", project, selectedSha],
    queryFn: () => api.coding.checkpointDiff(project, selectedSha!),
    enabled: Boolean(project && selectedSha),
  });

  const restore = useMutation({
    mutationFn: (sha: string) => api.coding.restoreCheckpoint(project, sha),
    onSuccess: () => {
      toastManager.success("Projekt auf den Checkpoint zurückgesetzt. Der vorherige Stand wurde vorher gesichert.");
      void queryClient.invalidateQueries({ queryKey: ["coding", "checkpoints", project] });
      void queryClient.invalidateQueries({ queryKey: ["coding", "files", project] });
      void queryClient.invalidateQueries({ queryKey: ["coding", "checkpoint-diff", project] });
    },
    onError: (error: unknown) => {
      toastManager.error(error instanceof Error ? error.message : "Zurücksetzen fehlgeschlagen");
    },
  });

  if (!project) {
    return <PanelEmpty icon={<History className="h-8 w-8" />} title="Kein Projekt ausgewählt" />;
  }

  if (checkpointsQuery.isLoading) {
    return <div className="p-3 text-xs text-muted-foreground">Checkpoints werden geladen…</div>;
  }

  if (checkpoints.length === 0) {
    return (
      <PanelEmpty
        icon={<History className="h-8 w-8" />}
        title="Noch keine Checkpoints"
      />
    );
  }

  const diff = diffQuery.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="max-h-48 shrink-0 overflow-y-auto border-b border-border">
        {checkpoints.map((checkpoint) => {
          const active = checkpoint.sha === selectedSha;
          return (
            <div
              key={checkpoint.sha}
              className={`flex items-center gap-2 border-b border-border/50 px-2 py-1.5 text-xs last:border-b-0 ${
                active ? "bg-primary/10" : "hover:bg-accent/50"
              }`}
            >
              <button
                type="button"
                onClick={() => setSelectedSha(active ? null : checkpoint.sha)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                title="Änderungen seit diesem Checkpoint anzeigen"
              >
                <GitCompare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{checkpoint.label}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {checkpoint.sha.slice(0, 7)}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{formatTime(checkpoint.createdAt)}</span>
              </button>
              <button
                type="button"
                disabled={restore.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Alle Dateien auf den Stand von "${checkpoint.label}" zurücksetzen?\n\n` +
                        `Der aktuelle Stand wird vorher automatisch als Checkpoint gesichert.`
                    )
                  ) {
                    restore.mutate(checkpoint.sha);
                  }
                }}
                title="Projekt auf diesen Stand zurücksetzen"
                className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-destructive disabled:opacity-30"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!selectedSha && (
          <div className="p-3 text-xs text-muted-foreground">
            Einen Checkpoint auswählen, um die Änderungen bis zum aktuellen Stand zu sehen.
          </div>
        )}

        {selectedSha && diffQuery.isLoading && (
          <div className="p-3 text-xs text-muted-foreground">Diff wird berechnet…</div>
        )}

        {selectedSha && diff && (
          <div className="space-y-2 p-2">
            {diff.files.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                Seit diesem Checkpoint wurde nichts geändert.
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-1">
                  {diff.files.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => onOpenFile?.(file.path)}
                      className="chip hover:border-primary/50 hover:text-primary"
                      title={`${file.path} im Editor öffnen`}
                    >
                      <span className="truncate">{file.path}</span>
                      <span className="shrink-0 text-emerald-500">+{file.added}</span>
                      <span className="shrink-0 text-red-500">-{file.removed}</span>
                    </button>
                  ))}
                </div>
                <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                  {diff.patch.split("\n").map((line, index) => (
                    <div key={index} className={diffLineClass(line)}>
                      {line || " "}
                    </div>
                  ))}
                </pre>
                {diff.truncated && (
                  <div className="text-[10px] text-muted-foreground">
                    Diff gekürzt – die vollständigen Änderungen stehen in den Dateien selbst.
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
