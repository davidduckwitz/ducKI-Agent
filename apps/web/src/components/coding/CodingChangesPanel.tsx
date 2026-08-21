import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, GitCompare, History, RotateCcw } from "lucide-react";
import { api } from "../../lib/api";
import { PanelEmpty } from "../ui/panel";
import { Switch } from "../ui/switch";
import { toastManager } from "../../lib/toast";
import { useUiStore } from "../../lib/uiStore";
import { FileIcon } from "./CodingFileTree";

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

/** Maps a git change type to the coarse bucket the Changes tab filters by. */
type FileStatusKind = "added" | "modified" | "deleted" | "other";
function statusKind(status?: string): FileStatusKind {
  if (status === "A" || status === "C") return "added";
  if (status === "D") return "deleted";
  if (status === "M" || status === "R" || status === "T") return "modified";
  return "other"; // U (unmerged), X (unknown), undefined
}

const STATUS_FILTERS: Array<{ key: "all" | FileStatusKind; label: string }> = [
  { key: "all", label: "Alle" },
  { key: "added", label: "Neu" },
  { key: "modified", label: "Geändert" },
  { key: "deleted", label: "Gelöscht" },
];

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

  // File-list filters: by change type (all/new/modified/deleted) and optionally hiding
  // entries without countable line changes (e.g. a pure file-mode change or a binary add).
  const [fileFilter, setFileFilter] = useState<(typeof STATUS_FILTERS)[number]["key"]>("all");
  const [onlyContentChanges, setOnlyContentChanges] = useState(false);

  // Per-file diff previews: which file rows currently show their own (collapsible) patch.
  const [expandedDiffs, setExpandedDiffs] = useState<Set<string>>(new Set());
  useEffect(() => {
    // A different checkpoint means a different patch - collapse everything again.
    setExpandedDiffs(new Set());
  }, [selectedSha]);

  const toggleFileDiff = (path: string) => {
    setExpandedDiffs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

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

  // Counts per status bucket + the rows actually rendered after filtering. Memoized on the
  // react-query data reference (stable between refetches), not on the freshly-built arrays.
  const diffFiles = diffQuery.data?.files;
  const fileCounts = useMemo(() => {
    const counts: Record<"all" | FileStatusKind, number> = {
      all: diffFiles?.length ?? 0,
      added: 0,
      modified: 0,
      deleted: 0,
      other: 0,
    };
    for (const file of diffFiles ?? []) counts[statusKind(file.status)]++;
    return counts;
  }, [diffFiles]);

  const visibleFiles = useMemo(() => {
    let list = diffFiles ?? [];
    if (onlyContentChanges) list = list.filter((f) => f.added > 0 || f.removed > 0);
    if (fileFilter !== "all") list = list.filter((f) => statusKind(f.status) === fileFilter);
    // Most-changed files first - that is what "readable at a glance" means for a review:
    // the rows that matter most sit at the top.
    return [...list].sort((a, b) => b.added + b.removed - (a.added + a.removed));
  }, [diffFiles, fileFilter, onlyContentChanges]);

  // Split the unified diff into per-file segments (`diff --git a/x b/x` headers). The rows
  // render their segment when expanded instead of dumping the whole patch below the list.
  const patchSegments = useMemo(() => {
    const segments = new Map<string, string>();
    if (!diffQuery.data) return segments;
    for (const part of diffQuery.data.patch.split(/(?=^diff --git )/m)) {
      const match = part.match(/^diff --git a\/(.+?) b\//m);
      const path = match?.[1];
      if (path) segments.set(path, part);
    }
    return segments;
  }, [diffQuery.data]);

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
                <div className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2 px-1 pb-0.5">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {fileFilter !== "all" || (onlyContentChanges && visibleFiles.length < diff.files.length)
                        ? `${visibleFiles.length} von ${diff.files.length} ${diff.files.length === 1 ? "Datei" : "Dateien"}`
                        : `${diff.files.length} ${diff.files.length === 1 ? "Datei" : "Dateien"}`}
                    </div>
                    <div className="flex overflow-hidden rounded-md border border-border text-[10px]">
                      {STATUS_FILTERS.map(({ key, label }) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setFileFilter(key)}
                          className={`px-1.5 py-0.5 transition ${
                            fileFilter === key
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-accent"
                          }`}
                        >
                          {label} {fileCounts[key]}
                        </button>
                      ))}
                    </div>
                    <label
                      className="flex cursor-pointer select-none items-center gap-1.5 text-[10px] text-muted-foreground"
                      title="Nur Dateien mit zählbaren Zeilenänderungen anzeigen – blendet Einträge ohne +/- aus (z. B. reine Datei-Modusänderungen oder Binärdateien)"
                    >
                      <Switch
                        checked={onlyContentChanges}
                        onCheckedChange={setOnlyContentChanges}
                        aria-label="Nur Dateien mit inhaltlichen Änderungen anzeigen"
                      />
                      Nur inhaltliche Änderungen
                    </label>
                  </div>
                  {visibleFiles.length === 0 && (
                    <div className="px-1 pb-1 text-[11px] text-muted-foreground">
                      Keine Dateien in dieser Ansicht.
                    </div>
                  )}
                  {visibleFiles.map((file) => {
                      const expanded = expandedDiffs.has(file.path);
                      const segment = patchSegments.get(file.path);
                      return (
                        <div
                          key={file.path}
                          className={`rounded-md border text-[11px] ${
                            expanded
                              ? "border-primary/25 bg-accent/20"
                              : "border-transparent hover:border-primary/30 hover:bg-accent/40"
                          }`}
                        >
                          <div className="flex items-center gap-1.5 px-1.5 py-1">
                            <button
                              type="button"
                              onClick={() => toggleFileDiff(file.path)}
                              disabled={!segment}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                              title={
                                segment
                                  ? "Diff-Vorschau dieser Datei ein-/ausblenden"
                                  : "Keine Diff-Vorschau verfügbar"
                              }
                            >
                              <ChevronRight
                                className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
                                  expanded ? "rotate-90" : ""
                                }`}
                              />
                              <FileIcon name={file.path} />
                              <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                              {statusKind(file.status) === "added" && (
                                <span className="shrink-0 rounded bg-emerald-500/15 px-1 py-px text-[9px] font-semibold uppercase text-emerald-500">
                                  Neu
                                </span>
                              )}
                              {statusKind(file.status) === "deleted" && (
                                <span className="shrink-0 rounded bg-red-500/15 px-1 py-px text-[9px] font-semibold uppercase text-red-500">
                                  Gelöscht
                                </span>
                              )}
                              <span className="shrink-0 text-emerald-500">+{file.added}</span>
                              <span className="shrink-0 text-red-500">-{file.removed}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => onOpenFile?.(file.path)}
                              title={`${file.path} im Editor öffnen`}
                              className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </button>
                          </div>
                          {expanded && segment && (
                            <pre className="mb-1.5 ml-6 mr-1.5 overflow-x-auto rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                              {segment.split("\n").map((line, index) => (
                                <div key={index} className={diffLineClass(line)}>
                                  {line || " "}
                                </div>
                              ))}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                </div>
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
