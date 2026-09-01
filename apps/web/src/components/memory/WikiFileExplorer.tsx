import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Download, File, Folder, FolderPlus, Plus, RefreshCw, Save, Trash2, Upload, X } from "lucide-react";
import { api } from "../../lib/api";
import { CodePreview } from "../common/CodePreview";

interface SharedItem {
  path: string;
  type: "file" | "directory";
  size?: number;
  updatedAt?: string;
}

interface SharedReadResponse {
  path: string;
  size: number;
  isText: boolean;
  content?: string;
  contentBase64?: string;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp",
};

function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "ts" || ext === "tsx") return "typescript";
  if (ext === "js" || ext === "jsx") return "javascript";
  if (ext === "json") return "json";
  if (ext === "md") return "markdown";
  if (ext === "py") return "python";
  if (ext === "css") return "css";
  if (ext === "html") return "html";
  if (ext === "yml" || ext === "yaml") return "yaml";
  return "text";
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function nameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function formatDate(iso?: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${d.toLocaleDateString("de-DE")} ${d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * Scoped file explorer over the shared-workspace folder that backs the LLM wiki
 * (WIKI_SHARED_SOURCE_PATH). Reuses the generic /shared/* file API but only ever
 * navigates/creates below `rootPath` - the wiki-ingest source directory itself.
 */
export function WikiFileExplorer({ rootPath }: { rootPath: string }) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentDir, setCurrentDir] = useState(rootPath);
  const [showNewFile, setShowNewFile] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newName, setNewName] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");

  // If the configured wiki source path changes, jump the browser back to it.
  useEffect(() => {
    setCurrentDir(rootPath);
    setSelectedFile(null);
  }, [rootPath]);

  const readSelected = useQuery({
    queryKey: ["shared", "read", selectedFile],
    queryFn: () => api.shared.readFile(selectedFile!) as Promise<SharedReadResponse>,
    enabled: Boolean(selectedFile),
  });

  useEffect(() => {
    if (!readSelected.data?.isText) {
      setEditorContent("");
      return;
    }
    setEditorContent(readSelected.data.content ?? "");
  }, [readSelected.data]);

  const hasChanges = Boolean(
    selectedFile && readSelected.data?.isText && (readSelected.data.content ?? "") !== editorContent
  );

  const imageDataUrl = useMemo(() => {
    if (!selectedFile || !readSelected.data || readSelected.data.isText || !readSelected.data.contentBase64) return undefined;
    const ext = selectedFile.split(".").pop()?.toLowerCase() ?? "";
    const mime = IMAGE_MIME_BY_EXT[ext];
    if (!mime) return undefined;
    return `data:${mime};base64,${readSelected.data.contentBase64}`;
  }, [selectedFile, readSelected.data]);

  const { data, isFetching } = useQuery({
    queryKey: ["shared", "files"],
    queryFn: () => api.shared.listFiles() as Promise<{ root: string; files: SharedItem[] }>,
    refetchInterval: 15000,
  });

  const files = data?.files ?? [];

  const refresh = () => qc.invalidateQueries({ queryKey: ["shared", "files"] });

  const entries = useMemo(() => {
    return files
      .filter((item) => dirOf(item.path) === currentDir)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return nameOf(a.path).localeCompare(nameOf(b.path));
      });
  }, [files, currentDir]);

  const breadcrumbs = useMemo(() => {
    const rootSegments = rootPath.split("/").filter(Boolean);
    const segments = currentDir.split("/").filter(Boolean);
    // Never let the crumbs (or navigation) rise above the wiki root folder.
    const crumbs: Array<{ label: string; path: string }> = [];
    let acc = "";
    for (let i = 0; i < segments.length; i++) {
      acc = acc ? `${acc}/${segments[i]}` : segments[i]!;
      if (i < rootSegments.length) continue; // skip crumbs at/above the wiki root itself
      crumbs.push({ label: segments[i]!, path: acc });
    }
    return crumbs;
  }, [currentDir, rootPath]);

  const createFile = useMutation({
    mutationFn: (name: string) => api.shared.writeFile(`${currentDir}/${name}`, ""),
    onSuccess: async () => {
      setNewName("");
      setShowNewFile(false);
      await refresh();
    },
  });

  const createFolder = useMutation({
    mutationFn: (name: string) => api.shared.createDir(`${currentDir}/${name}`),
    onSuccess: async () => {
      setNewName("");
      setShowNewFolder(false);
      await refresh();
    },
  });

  const deleteEntry = useMutation({
    mutationFn: (path: string) => api.shared.deleteFile(path),
    onSuccess: async (_result, path) => {
      if (path === selectedFile) setSelectedFile(null);
      await refresh();
    },
  });

  const saveFile = useMutation({
    mutationFn: () => api.shared.writeFile(selectedFile!, editorContent),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["shared", "read", selectedFile] });
      await refresh();
    },
  });

  const selectFile = (path: string) => {
    if (hasChanges && !window.confirm("Ungespeicherte Änderungen verwerfen?")) return;
    setSelectedFile(path);
  };

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const raw = String(reader.result ?? "");
          resolve(raw.includes(",") ? (raw.split(",")[1] ?? "") : raw);
        };
        reader.onerror = () => reject(new Error("Datei konnte nicht gelesen werden"));
        reader.readAsDataURL(file);
      });
      return api.shared.uploadFile({ fileName: file.name, contentBase64: base64, folder: currentDir });
    },
    onSuccess: refresh,
  });

  const atRoot = currentDir === rootPath;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <button
            className={`px-1.5 py-0.5 rounded ${atRoot ? "text-blue-300" : "text-gray-400 hover:text-gray-200"}`}
            onClick={() => setCurrentDir(rootPath)}
          >
            {rootPath}
          </button>
          {breadcrumbs.map((crumb) => (
            <span key={crumb.path} className="flex items-center gap-1">
              <ChevronRight className="w-3.5 h-3.5 text-gray-600" />
              <button
                className={`px-1.5 py-0.5 rounded ${crumb.path === currentDir ? "text-blue-300" : "text-gray-400 hover:text-gray-200"}`}
                onClick={() => setCurrentDir(crumb.path)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary flex items-center gap-1 text-xs px-2 py-1" onClick={() => { setShowNewFile((v) => !v); setShowNewFolder(false); }}>
            <Plus className="w-3.5 h-3.5" /> Datei
          </button>
          <button className="btn-secondary flex items-center gap-1 text-xs px-2 py-1" onClick={() => { setShowNewFolder((v) => !v); setShowNewFile(false); }}>
            <FolderPlus className="w-3.5 h-3.5" /> Ordner
          </button>
          <button className="btn-secondary flex items-center gap-1 text-xs px-2 py-1" onClick={() => fileInputRef.current?.click()} disabled={upload.isPending}>
            <Upload className="w-3.5 h-3.5" /> Hochladen
          </button>
          <button className="btn-secondary flex items-center gap-1 text-xs px-2 py-1" onClick={() => refresh()} disabled={isFetching}>
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={async (e) => {
              const selected = Array.from(e.target.files ?? []);
              for (const file of selected) {
                await upload.mutateAsync(file);
              }
              e.currentTarget.value = "";
            }}
          />
        </div>
      </div>

      {(showNewFile || showNewFolder) && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/60 p-2">
          <input
            className="input flex-1 text-sm"
            placeholder={showNewFolder ? "Ordnername..." : "Dateiname (z. B. notiz.md)..."}
            value={newName}
            autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !newName.trim()) return;
              if (showNewFolder) createFolder.mutate(newName.trim());
              else createFile.mutate(newName.trim());
            }}
          />
          <button
            className="btn-primary text-xs px-2 py-1"
            disabled={!newName.trim() || createFile.isPending || createFolder.isPending}
            onClick={() => (showNewFolder ? createFolder.mutate(newName.trim()) : createFile.mutate(newName.trim()))}
          >
            Anlegen
          </button>
          <button
            className="btn-secondary text-xs px-2 py-1"
            onClick={() => {
              setShowNewFile(false);
              setShowNewFolder(false);
              setNewName("");
            }}
          >
            Abbrechen
          </button>
        </div>
      )}

      <div className="rounded-lg border border-gray-800 divide-y divide-gray-800 max-h-[420px] overflow-y-auto">
        <div className="grid grid-cols-[1fr,160px,60px] gap-2 px-3 py-1.5 text-[11px] uppercase tracking-wide text-gray-500 bg-gray-900/60">
          <span>Name</span>
          <span>Datum / Uhrzeit</span>
          <span></span>
        </div>
        {entries.map((entry) => {
          const isDir = entry.type === "directory";
          const isSelected = !isDir && entry.path === selectedFile;
          return (
            <div
              key={entry.path}
              className={`grid grid-cols-[1fr,160px,60px] gap-2 px-3 py-2 items-center hover:bg-gray-900/40 ${isSelected ? "bg-blue-500/10" : ""}`}
            >
              <button
                className="flex items-center gap-2 min-w-0 text-left"
                onClick={() => (isDir ? setCurrentDir(entry.path) : selectFile(entry.path))}
              >
                {isDir ? <Folder className="w-4 h-4 shrink-0 text-yellow-400" /> : <File className="w-4 h-4 shrink-0 text-blue-300" />}
                <span className={`text-sm truncate ${isDir ? "text-gray-100" : isSelected ? "text-blue-300" : "text-gray-200"}`}>
                  {nameOf(entry.path)}
                </span>
              </button>
              <span className="text-xs text-gray-500">{formatDate(entry.updatedAt)}</span>
              <button
                className="justify-self-end text-red-400 hover:text-red-300 p-1"
                title="Löschen"
                onClick={() => {
                  const label = isDir ? `Ordner "${nameOf(entry.path)}" und Inhalt löschen?` : `Datei "${nameOf(entry.path)}" löschen?`;
                  if (window.confirm(label)) deleteEntry.mutate(entry.path);
                }}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          );
        })}
        {entries.length === 0 && <div className="px-3 py-6 text-center text-sm text-gray-500">Ordner ist leer.</div>}
      </div>

      {selectedFile && (
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{selectedFile}</p>
              {readSelected.data && <p className="text-xs text-gray-500">{readSelected.data.size} Bytes</p>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <a href={api.shared.downloadUrl(selectedFile)} className="btn-secondary flex items-center gap-1 text-xs px-2 py-1">
                <Download className="w-3.5 h-3.5" /> Download
              </a>
              <button className="text-gray-400 hover:text-white p-1" onClick={() => setSelectedFile(null)}>
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {readSelected.isLoading && <p className="text-sm text-gray-500">Wird geladen...</p>}

          {readSelected.data?.isText && (
            <div className="space-y-2">
              <textarea
                className="input w-full min-h-[320px] font-mono text-xs"
                value={editorContent}
                onChange={(e) => setEditorContent(e.target.value)}
              />
              <div className="rounded-lg border border-gray-800 overflow-hidden">
                <div className="px-3 py-2 text-xs text-gray-400 border-b border-gray-800 bg-gray-900/60">Vorschau</div>
                <CodePreview code={editorContent} language={languageFor(selectedFile)} maxHeight={280} fontSize={12} />
              </div>
              <div className="flex justify-end">
                <button
                  className="btn-primary flex items-center gap-2 disabled:opacity-50"
                  disabled={!hasChanges || saveFile.isPending}
                  onClick={() => saveFile.mutate()}
                >
                  <Save className="w-4 h-4" />
                  Speichern
                </button>
              </div>
            </div>
          )}

          {readSelected.data && !readSelected.data.isText && (
            <div className="text-sm text-gray-300">
              {imageDataUrl ? (
                <img src={imageDataUrl} alt={selectedFile} className="max-h-[420px] rounded border border-gray-800" />
              ) : (
                <p>Keine Vorschau verfügbar ({readSelected.data.size} Bytes) - bitte herunterladen.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
