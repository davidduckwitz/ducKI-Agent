import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, Folder, FolderOpen, FolderSearch, HardDrive, X } from "lucide-react";
import { api } from "../../lib/api";
import { toastManager } from "../../lib/toast";
import { useCodingSession } from "../../lib/codingSessionStore";

export interface CodingProjectEntry {
  slug: string;
  name: string;
  linked?: boolean;
  path?: string;
}

/**
 * Inline "open folder" control: links any directory on the server's disk as a coding project
 * (worked on in place, no copy) and switches to it. Used in the explorer sidebar and the
 * workspace toolbar so the working directory can be changed without leaving the coding area.
 */
export function CodingFolderPicker({
  projects,
  compact = false,
}: {
  projects: CodingProjectEntry[];
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const { selectedProject, setSelectedProject } = useCodingSession();
  const current = projects.find((p) => p.slug === selectedProject);
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState("");
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    if (editing) setPath(current?.path ?? "");
  }, [editing, current?.path]);

  const link = useMutation({
    mutationFn: (folder: string) => {
      // Re-entering the folder of an already linked project just switches to it.
      const existing = projects.find((p) => p.linked && p.path?.toLowerCase() === folder.toLowerCase());
      return existing
        ? Promise.resolve({ slug: existing.slug })
        : api.coding.linkProject(folder);
    },
    onSuccess: async ({ slug }) => {
      await qc.refetchQueries({ queryKey: ["coding", "projects"] });
      setSelectedProject(slug);
      setEditing(false);
    },
    onError: (error: unknown) => {
      toastManager.error(error instanceof Error ? error.message : "Ordner konnte nicht geöffnet werden");
    },
  });

  const submit = () => {
    const folder = path.trim().replace(/^["']|["']$/g, "");
    if (folder) link.mutate(folder);
  };

  const browser = browsing && (
    <FolderBrowserDialog
      initialPath={path.trim() || current?.path || ""}
      onCancel={() => setBrowsing(false)}
      onSelect={(folder) => {
        setBrowsing(false);
        setPath(folder);
        link.mutate(folder);
      }}
    />
  );

  if (editing) {
    return (
      <div className={`flex min-w-0 items-center gap-1 ${compact ? "flex-1" : "w-full"}`}>
        <input
          autoFocus
          className="input min-w-0 flex-1 py-1 font-mono text-xs"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") setEditing(false);
          }}
          placeholder="Absoluter Ordnerpfad, z.B. M:\projekte\mein-repo"
        />
        <button
          type="button"
          onClick={() => setBrowsing(true)}
          title="Ordner auswählen…"
          className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <FolderSearch className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!path.trim() || link.isPending}
          title="Ordner öffnen"
          className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          title="Abbrechen"
          className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        {browser}
      </div>
    );
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={current?.path ? `Arbeitsverzeichnis: ${current.path} – ändern` : "Ordner als Arbeitsverzeichnis öffnen"}
        className="shrink-0 rounded-md border border-border p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
      >
        <FolderOpen className="h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Arbeitsverzeichnis ändern"
      className="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
    >
      <FolderOpen className="h-3 w-3 shrink-0" />
      <span className="truncate font-mono" dir="rtl">
        {current?.path ?? (current ? `coding/${current.slug}` : "Ordner öffnen…")}
      </span>
    </button>
  );
}

/** Modal that walks the server's directory tree; the user clicks through folders instead of typing. */
export function FolderBrowserDialog({
  initialPath,
  onSelect,
  onCancel,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}) {
  const [dir, setDir] = useState(initialPath);
  const query = useQuery({
    queryKey: ["coding", "browse", dir],
    queryFn: () => api.coding.browseFolders(dir),
    retry: false,
  });
  // An unusable start path (typo, deleted folder) falls back to the root list instead of a dead end.
  useEffect(() => {
    if (query.isError && dir === initialPath && dir) setDir("");
  }, [query.isError, dir, initialPath]);

  const data = query.data;
  const atRoots = !data?.path;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Ordner auswählen</h2>
          <button className="rounded p-1 hover:bg-accent" onClick={onCancel}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          <button
            type="button"
            disabled={atRoots}
            onClick={() => setDir(data?.parent ?? "")}
            title="Übergeordneter Ordner"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <span className="truncate font-mono text-xs text-muted-foreground" dir="rtl">
            {atRoots ? "Laufwerke & Home" : data?.path}
          </span>
        </div>
        <div className="min-h-[240px] flex-1 overflow-y-auto p-1">
          {query.isLoading && <p className="p-3 text-xs text-muted-foreground">Lade…</p>}
          {query.isError && dir && (
            <p className="p-3 text-xs text-destructive">
              {query.error instanceof Error ? query.error.message : "Ordner nicht lesbar"}
            </p>
          )}
          {data && data.entries.length === 0 && (
            <p className="p-3 text-xs text-muted-foreground">Keine Unterordner.</p>
          )}
          {data?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => setDir(entry.path)}
              onDoubleClick={() => onSelect(entry.path)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              {atRoots ? (
                <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="h-4 w-4 shrink-0 text-primary" />
              )}
              <span className="truncate">{entry.name}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button className="btn-secondary" onClick={onCancel}>
            Abbrechen
          </button>
          <button className="btn-primary" disabled={atRoots} onClick={() => data?.path && onSelect(data.path)}>
            <FolderOpen className="mr-1 inline h-4 w-4" />
            Diesen Ordner öffnen
          </button>
        </div>
      </div>
    </div>
  );
}
