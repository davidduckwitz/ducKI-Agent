import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitCompare, History, RotateCcw } from "lucide-react";
import { api } from "../../lib/api";
import { PanelEmpty } from "../ui/panel";
import { toastManager } from "../../lib/toast";
import { useUiStore } from "../../lib/uiStore";

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
  const codingChangesSelected = useUiStore((s) => s.codingChangesSelected);
  const setCodingChangesSelected = useUiStore((s) => s.setCodingChangesSelected);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  // True while the current selection is the user's own (persisted) choice; false while it
  // is the auto-followed newest checkpoint. Kept in a ref so the render cycle never has to
  // reconcile the two.
  const manualSelectionRef = useRef(false);
  // The sha the auto-follow last picked. Lets the auto-follow detect "a newer checkpoint
  // appeared" without re-setting the same value, and keeps the hint visible right after a
  // manual deselection (same newest -> no re-select).
  const lastAutoShaRef = useRef<string | null>(null);

  const checkpointsQuery = useQuery({
    queryKey: ["coding", "checkpoints", project, refreshKey],
    queryFn: () => api.coding.listCheckpoints(project),
    enabled: Boolean(project),
  });

  const checkpoints: Checkpoint[] = useMemo(
    () => checkpointsQuery.data?.checkpoints ?? [],
    [checkpointsQuery.data]
  );

  // Project switch: load the persisted explicit choice (or none) and reset the auto-follow
  // state. Declared BEFORE the auto-follow effect so a persisted choice wins on the first
  // render instead of being immediately overridden by the newest checkpoint.
  useEffect(() => {
    const persisted = codingChangesSelected[project] ?? null;
    setSelectedSha(persisted);
    manualSelectionRef.current = persisted !== null;
    lastAutoShaRef.current = null;
    // project changes are the only thing that must reset the selection; the persisted map
    // is read on switch, not watched continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // Auto-follow the newest checkpoint: when the list first loads with nothing selected, when
  // a fresh run adds a newer checkpoint, or when an explicit (persisted) choice no longer
  // exists (project was reset/restored). A manual selection is never overridden - the user
  // may be reviewing an older checkpoint while a newer run finishes. After a manual
  // deselection the hint stays visible until a NEWER checkpoint appears (lastAutoShaRef
  // remembers what we last followed).
  useEffect(() => {
    const newest = checkpoints[0]?.sha;
    if (!newest) return;

    // Explicit choice that vanished from the list: drop it and fall back to auto-follow.
    if (manualSelectionRef.current) {
      if (selectedSha !== null && !checkpoints.some((c) => c.sha === selectedSha)) {
        setSelectedSha(null);
        manualSelectionRef.current = false;
        setCodingChangesSelected(project, null);
        lastAutoShaRef.current = null;
      }
      return;
    }

    const newerArrived = lastAutoShaRef.current !== newest;
    if (selectedSha === null ? newerArrived : selectedSha !== newest && newerArrived) {
      setSelectedSha(newest);
      lastAutoShaRef.current = newest;
    }
  }, [checkpoints, selectedSha, project, setCodingChangesSelected]);

  const handleSelectCheckpoint = (sha: string) => {
    manualSelectionRef.current = true;
    setSelectedSha(sha);
    setCodingChangesSelected(project, sha);
  };

  const handleDeselectCheckpoint = () => {
    // Back to following the newest: keep lastAutoShaRef at the current newest so the hint
    // stays visible instead of instantly re-selecting it.
    manualSelectionRef.current = false;
    setSelectedSha(null);
    setCodingChangesSelected(project, null);
  };

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
                onClick={() => (active ? handleDeselectCheckpoint() : handleSelectCheckpoint(checkpoint.sha))}
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
