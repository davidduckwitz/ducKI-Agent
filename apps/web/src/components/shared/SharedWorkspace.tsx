import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { FileText, FolderOpen, Upload, Trash2, Plus, RefreshCw, Save, ArrowRightLeft, Download } from "lucide-react";
import { CodePreview } from "../common/CodePreview";
import { useI18n } from "../../lib/i18n";

interface SharedItem {
  path: string;
  type: "file" | "directory";
  size?: number;
  updatedAt?: string;
}

interface SharedListResponse {
  root: string;
  files: SharedItem[];
}

interface SharedReadResponse {
  path: string;
  size: number;
  isText: boolean;
  content?: string;
  contentBase64?: string;
}

export function SharedWorkspace() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedPath, setSelectedPath] = useState<string>("");
  const [newFilePath, setNewFilePath] = useState("");
  const [newFileContent, setNewFileContent] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [moveToPath, setMoveToPath] = useState("");

  const { data, isFetching } = useQuery({
    queryKey: ["shared", "files"],
    queryFn: () => api.shared.listFiles() as Promise<SharedListResponse>,
  });

  const selectedItem = useMemo(
    () => (data?.files ?? []).find((item) => item.path === selectedPath),
    [data?.files, selectedPath]
  );

  const readSelected = useQuery({
    queryKey: ["shared", "read", selectedPath],
    queryFn: () => api.shared.readFile(selectedPath) as Promise<SharedReadResponse>,
    enabled: Boolean(selectedPath && selectedItem?.type === "file"),
  });

  useEffect(() => {
    if (!readSelected.data || !readSelected.data.isText) {
      setEditorContent("");
      return;
    }
    setEditorContent(readSelected.data.content ?? "");
  }, [readSelected.data]);

  useEffect(() => {
    if (!selectedPath) {
      setMoveToPath("");
      return;
    }
    setMoveToPath(selectedPath);
  }, [selectedPath]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["shared", "files"] });
    if (selectedPath) {
      await qc.invalidateQueries({ queryKey: ["shared", "read", selectedPath] });
    }
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
      return api.shared.uploadFile({ fileName: file.name, contentBase64: base64 });
    },
    onSuccess: async () => {
      await refresh();
    },
  });

  const createFile = useMutation({
    mutationFn: () => api.shared.writeFile(newFilePath, newFileContent),
    onSuccess: async (result) => {
      setSelectedPath(result.path);
      setNewFilePath("");
      setNewFileContent("");
      await refresh();
    },
  });

  const deletePath = useMutation({
    mutationFn: (path: string) => api.shared.deleteFile(path),
    onSuccess: async () => {
      setSelectedPath("");
      await refresh();
    },
  });

  const saveFile = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) => api.shared.writeFile(path, content),
    onSuccess: async () => {
      await refresh();
    },
  });

  const movePath = useMutation({
    mutationFn: ({ fromPath, toPath }: { fromPath: string; toPath: string }) => api.shared.moveFile(fromPath, toPath),
    onSuccess: async (result) => {
      setSelectedPath(result.toPath);
      await refresh();
    },
  });

  const files = data?.files ?? [];

  const imageDataUrl = useMemo(() => {
    if (!selectedItem || selectedItem.type !== "file") return undefined;
    if (!readSelected.data || readSelected.data.isText || !readSelected.data.contentBase64) return undefined;
    if (!/\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(selectedItem.path)) return undefined;

    const ext = selectedItem.path.split(".").pop()?.toLowerCase();
    const mimeByExt: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      bmp: "image/bmp",
    };
    const mime = ext ? mimeByExt[ext] : "application/octet-stream";
    return `data:${mime};base64,${readSelected.data.contentBase64}`;
  }, [selectedItem, readSelected.data]);

  const hasTextChanges = Boolean(
    selectedItem?.type === "file" &&
    readSelected.data?.isText &&
    (readSelected.data.content ?? "") !== editorContent
  );

  const selectedLanguage = useMemo(() => {
    if (!selectedPath) return "text";
    const ext = selectedPath.split(".").pop()?.toLowerCase();
    if (ext === "ts" || ext === "tsx") return "typescript";
    if (ext === "js" || ext === "jsx") return "javascript";
    if (ext === "json") return "json";
    if (ext === "md") return "markdown";
    if (ext === "py") return "python";
    if (ext === "css") return "css";
    if (ext === "html") return "html";
    if (ext === "yml" || ext === "yaml") return "yaml";
    return "text";
  }, [selectedPath]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasTextChanges) return;
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasTextChanges]);

  const selectPath = (path: string) => {
    if (hasTextChanges) {
      const proceed = window.confirm(t("shared.discardConfirm"));
      if (!proceed) return;
    }
    setSelectedPath(path);
  };

  return (
    <div className="p-6 space-y-4 h-full">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Shared Workspace</h1>
          <p className="text-sm text-gray-400">{t("shared.subtitle")}</p>
          <p className="text-xs text-gray-500 mt-1">Root: {data?.root ?? "-"}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="btn-secondary flex items-center gap-2"
            disabled={upload.isPending}
          >
            <Upload className="w-4 h-4" />
            {t("shared.uploadFile")}
          </button>
          <button onClick={refresh} className="btn-secondary flex items-center gap-2" disabled={isFetching}>
            <RefreshCw className="w-4 h-4" />
            {t("common.refresh")}
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

      <div className="grid grid-cols-1 xl:grid-cols-[420px,1fr] gap-4 h-[calc(100%-95px)] min-h-[520px]">
        <section className="card overflow-y-auto space-y-3">
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-3 space-y-2">
            <p className="text-sm font-semibold">{t("shared.createFile")}</p>
            <input
              className="input"
              placeholder="z. B. prompts/review.md"
              value={newFilePath}
              onChange={(e) => setNewFilePath(e.target.value)}
            />
            <textarea
              className="input min-h-24"
              placeholder="Inhalt"
              value={newFileContent}
              onChange={(e) => setNewFileContent(e.target.value)}
            />
            <button
              onClick={() => createFile.mutate()}
              disabled={!newFilePath.trim() || createFile.isPending}
              className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              {t("shared.createFileButton")}
            </button>
          </div>

          <div className="space-y-1">
            {files.map((item) => (
              <button
                key={item.path}
                onClick={() => selectPath(item.path)}
                className={`w-full text-left rounded-lg border px-3 py-2 transition ${
                  selectedPath === item.path ? "border-blue-500 bg-blue-500/10" : "border-gray-800 bg-gray-900 hover:border-gray-700"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 min-w-0">
                    {item.type === "directory" ? <FolderOpen className="w-4 h-4 text-yellow-300 shrink-0" /> : <FileText className="w-4 h-4 text-blue-300 shrink-0" />}
                    <span className="text-sm truncate">{item.path}</span>
                  </span>
                  {item.type === "file" && (
                    <span className="text-[11px] text-gray-500 shrink-0">{item.size ?? 0} B</span>
                  )}
                </div>
              </button>
            ))}

            {files.length === 0 && (
              <div className="text-sm text-gray-500 py-4 text-center">{t("shared.noFiles")}</div>
            )}
          </div>
        </section>

        <section className="card overflow-y-auto">
          {!selectedPath && <p className="text-gray-500">{t("shared.selectLeft")}</p>}

          {selectedPath && selectedItem && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold">{selectedItem.path}</h2>
                  <p className="text-xs text-gray-500 capitalize">{selectedItem.type}</p>
                </div>
                <div className="flex items-center gap-2">
                  {selectedItem.type === "file" && (
                    <a
                      href={api.shared.downloadUrl(selectedItem.path)}
                      className="btn-secondary flex items-center gap-2"
                    >
                      <Download className="w-4 h-4" />
                      Download
                    </a>
                  )}
                  <button
                    onClick={() => deletePath.mutate(selectedItem.path)}
                    className="btn-secondary flex items-center gap-2 text-red-300"
                    disabled={deletePath.isPending}
                  >
                    <Trash2 className="w-4 h-4" />
                    {t("shared.delete")}
                  </button>
                </div>
              </div>

              <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 space-y-2">
                <p className="text-xs text-gray-400">Rename / Move</p>
                <div className="flex gap-2">
                  <input
                    className="input flex-1"
                    value={moveToPath}
                    onChange={(e) => setMoveToPath(e.target.value)}
                  />
                  <button
                    onClick={() => {
                      if (!selectedItem) return;
                      if (!moveToPath.trim() || moveToPath.trim() === selectedItem.path) return;
                      movePath.mutate({ fromPath: selectedItem.path, toPath: moveToPath.trim() });
                    }}
                    disabled={!selectedItem || !moveToPath.trim() || moveToPath.trim() === selectedItem.path || movePath.isPending}
                    className="btn-secondary flex items-center gap-2 disabled:opacity-50"
                  >
                    <ArrowRightLeft className="w-4 h-4" />
                    {t("shared.move")}
                  </button>
                </div>
              </div>

              {selectedItem.type === "file" && readSelected.data?.isText && (
                <div className="space-y-2">
                  <textarea
                    className="input w-full min-h-[420px] font-mono text-xs"
                    value={editorContent}
                    onChange={(e) => setEditorContent(e.target.value)}
                  />
                  <div className="rounded-lg border border-gray-800 overflow-hidden">
                    <div className="px-3 py-2 text-xs text-gray-400 border-b border-gray-800 bg-gray-900/60">
                      {t("shared.preview")}
                    </div>
                    <CodePreview code={editorContent} language={selectedLanguage} maxHeight={320} fontSize={12} />
                  </div>
                  <div className="flex justify-end">
                    <button
                      onClick={() => saveFile.mutate({ path: selectedItem.path, content: editorContent })}
                      disabled={!hasTextChanges || saveFile.isPending}
                      className="btn-primary flex items-center gap-2 disabled:opacity-50"
                    >
                      <Save className="w-4 h-4" />
                      {t("shared.save")}
                    </button>
                  </div>
                </div>
              )}

              {selectedItem.type === "file" && readSelected.data && !readSelected.data.isText && (
                <div className="text-sm text-gray-300 space-y-2">
                  {imageDataUrl ? (
                    <img src={imageDataUrl} alt={selectedItem.path} className="max-h-[420px] rounded border border-gray-800" />
                  ) : (
                    <div>{t("shared.binaryNoPreview")} ({readSelected.data.size} Bytes).</div>
                  )}
                </div>
              )}

              {selectedItem.type === "directory" && (
                <div className="text-sm text-gray-400">{t("shared.directorySelected")}</div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
