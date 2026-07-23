import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Eye, Plus, Save, Send, Trash2, Upload, X } from "lucide-react";
import Editor from "@monaco-editor/react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useAppStore } from "../../lib/store";
import { useCodingSession } from "../../lib/codingSessionStore";

interface CodingFileItem {
  path: string;
  type: "file" | "directory";
  size?: number;
  updatedAt?: string;
}

interface PersistedMessage {
  id: number;
  role: "user" | "assistant" | "system" | "tool" | "event";
  content: string;
  metadata?: string | null;
  toolResult?: string | null;
  createdAt: string;
}

interface StoreChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "event" | "tool";
  content: string;
  timestamp: string;
  eventType?: "plan" | "iteration" | "tool_call" | "tool_result" | "reasoning" | "decision" | "guardrail";
  eventData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const PROJECT_CONVERSATION_MAP_KEY = "coding.project.conversations.v1";

function isConversationNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("conversation") && msg.includes("not found");
}

function parseMessageMetadata(raw?: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "ts" || ext === "tsx") return "typescript";
  if (ext === "js" || ext === "jsx") return "javascript";
  if (ext === "json") return "json";
  if (ext === "md") return "markdown";
  if (ext === "py") return "python";
  if (ext === "css") return "css";
  if (ext === "html") return "html";
  if (ext === "yml" || ext === "yaml") return "yaml";
  if (ext === "xml") return "xml";
  return "plaintext";
}

function getFileExtension(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function isHtmlFile(path: string): boolean {
  const ext = getFileExtension(path);
  return ext === "html" || ext === "htm";
}

function isImageFile(path: string): boolean {
  const ext = getFileExtension(path);
  return ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp" || ext === "svg";
}

export function CodingWorkspace() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { messages, sendMessage, isLoading, setConversationId, setMessages } = useAppStore();
  const creatingConversationRef = useRef<Record<string, boolean>>({});

  const { selectedProject, setSelectedProject, selectedPath, setSelectedPath } = useCodingSession();
  const [newProjectName, setNewProjectName] = useState("");
  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [editorContent, setEditorContent] = useState("");
  const [moveTarget, setMoveTarget] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [isEnsuringConversation, setIsEnsuringConversation] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [projectConversationMap, setProjectConversationMap] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(PROJECT_CONVERSATION_MAP_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") return {};
      const obj = parsed as Record<string, unknown>;
      const result: Record<string, number> = {};
      for (const [key, value] of Object.entries(obj)) {
        const id = Number(value);
        if (Number.isFinite(id) && id > 0) result[key] = id;
      }
      return result;
    } catch {
      return {};
    }
  });

  useEffect(() => {
    localStorage.setItem(PROJECT_CONVERSATION_MAP_KEY, JSON.stringify(projectConversationMap));
  }, [projectConversationMap]);

  const settingsQuery = useQuery({
    queryKey: ["settings", "coding-workspace"],
    queryFn: () => api.settings.list() as Promise<Array<{ key: string; value: string }>>,
    refetchInterval: 5000,
  });
  const codingSettingRaw = settingsQuery.data?.find((s) => s.key === "CODING_ENABLED")?.value;
  const codingEnabled = String(codingSettingRaw ?? "false").trim().toLowerCase() === "true";
  const codingSettingReady = !settingsQuery.isLoading && Boolean(settingsQuery.data);

  const activeConversationId = selectedProject ? projectConversationMap[selectedProject] : undefined;

  useEffect(() => {
    if (!codingSettingReady || !codingEnabled || !selectedProject) return;

    const existingConversationId = projectConversationMap[selectedProject];
    if (existingConversationId) {
      setConversationId(existingConversationId);
      return;
    }

    if (creatingConversationRef.current[selectedProject]) {
      return;
    }

    creatingConversationRef.current[selectedProject] = true;

    void (async () => {
      try {
        const created = await api.chat.createConversation({ name: `[Coding] ${selectedProject}` });
        setProjectConversationMap((prev) => ({
          ...prev,
          [selectedProject]: created.conversationId,
        }));
        setConversationId(created.conversationId);
      } catch {
        // Keep UI responsive; user can retry by reselecting project.
      } finally {
        delete creatingConversationRef.current[selectedProject];
      }
    })();
  }, [codingSettingReady, codingEnabled, selectedProject, projectConversationMap, setConversationId]);

  const conversationMessagesQuery = useQuery({
    queryKey: ["coding", "conversation", activeConversationId],
    queryFn: () => api.chat.getMessages(activeConversationId ?? 0) as Promise<PersistedMessage[]>,
    enabled: codingSettingReady && codingEnabled && Boolean(activeConversationId),
    refetchInterval: 3000,
  });

  useEffect(() => {
    if (!selectedProject || !activeConversationId) return;
    if (!conversationMessagesQuery.error) return;
    if (!isConversationNotFoundError(conversationMessagesQuery.error)) return;

    setProjectConversationMap((prev) => {
      if (prev[selectedProject] !== activeConversationId) return prev;
      const next = { ...prev };
      delete next[selectedProject];
      return next;
    });
    setConversationId(undefined);
    setMessages([] as never);
  }, [activeConversationId, conversationMessagesQuery.error, selectedProject, setConversationId, setMessages]);

  useEffect(() => {
    const persisted = conversationMessagesQuery.data;
    if (!persisted) return;

    const mapped: StoreChatMessage[] = persisted.map((msg) => {
      const metadata = parseMessageMetadata(msg.metadata);
      if (msg.role === "event") {
        let eventType: StoreChatMessage["eventType"];
        let eventData: Record<string, unknown> | undefined;

        if (msg.toolResult) {
          try {
            const parsed = JSON.parse(msg.toolResult) as { eventType?: string; data?: Record<string, unknown> };
            const type = parsed.eventType;
            if (type === "plan" || type === "iteration" || type === "tool_call" || type === "tool_result" || type === "reasoning" || type === "decision" || type === "guardrail") {
              eventType = type;
            }
            eventData = parsed.data;
          } catch {
            // ignore malformed payload
          }
        }

        return {
          id: `db-${msg.id}`,
          role: "event",
          content: msg.content,
          timestamp: msg.createdAt,
          eventType,
          eventData,
          metadata,
        };
      }

      return {
        id: `db-${msg.id}`,
        role: msg.role,
        content: msg.content,
        timestamp: msg.createdAt,
        metadata,
      };
    });

    setMessages(mapped as never);
  }, [conversationMessagesQuery.data, setMessages]);

  useEffect(() => {
    if (codingSettingReady && !codingEnabled) {
      setSelectedProject("");
    }
  }, [codingSettingReady, codingEnabled, setSelectedProject]);

  const filesQuery = useQuery({
    queryKey: ["coding", "files", selectedProject],
    queryFn: () => api.coding.listFiles(selectedProject) as Promise<{ project: string; files: CodingFileItem[] }>,
    enabled: codingSettingReady && codingEnabled && Boolean(selectedProject),
    refetchInterval: selectedProject && isLoading ? 1500 : false,
  });

  useEffect(() => {
    if (!selectedProject) return;
    const last = messages[messages.length - 1];
    if (!last) return;
    if (last.role === "user") return;
    void qc.invalidateQueries({ queryKey: ["coding", "files", selectedProject] });
  }, [messages, qc, selectedProject]);

  const selectedItem = useMemo(
    () => (filesQuery.data?.files ?? []).find((file) => file.path === selectedPath),
    [filesQuery.data?.files, selectedPath]
  );

  const readFileQuery = useQuery({
    queryKey: ["coding", "read", selectedProject, selectedPath],
    queryFn: () => api.coding.readFile(selectedProject, selectedPath),
    enabled: codingSettingReady && codingEnabled && Boolean(selectedProject && selectedPath && selectedItem?.type === "file"),
  });

  useEffect(() => {
    if (readFileQuery.data?.isText) {
      setEditorContent(readFileQuery.data.content ?? "");
    } else {
      setEditorContent("");
    }
  }, [readFileQuery.data]);

  useEffect(() => {
    if (!selectedPath) {
      setMoveTarget("");
      return;
    }
    setMoveTarget(selectedPath);
  }, [selectedPath]);

  const createProject = useMutation({
    mutationFn: (name: string) => api.coding.createProject(name),
    onSuccess: async (data) => {
      setNewProjectName("");
      setShowCreateProjectModal(false);
      setSelectedProject(data.slug);
      await qc.invalidateQueries({ queryKey: ["coding", "projects"] });
      await qc.invalidateQueries({ queryKey: ["coding", "files", data.slug] });
    },
  });

  const writeFile = useMutation({
    mutationFn: (payload: { path: string; content: string }) => api.coding.writeFile(selectedProject, payload.path, payload.content),
    onSuccess: async (_data, vars) => {
      setSelectedPath(vars.path);
      await qc.invalidateQueries({ queryKey: ["coding", "files", selectedProject] });
      await qc.invalidateQueries({ queryKey: ["coding", "read", selectedProject, vars.path] });
    },
  });

  const moveFile = useMutation({
    mutationFn: (payload: { fromPath: string; toPath: string }) => api.coding.moveFile(selectedProject, payload.fromPath, payload.toPath),
    onSuccess: async (result) => {
      setSelectedPath(result.toPath);
      await qc.invalidateQueries({ queryKey: ["coding", "files", selectedProject] });
      await qc.invalidateQueries({ queryKey: ["coding", "read", selectedProject, result.toPath] });
    },
  });

  const deleteFile = useMutation({
    mutationFn: (path: string) => api.coding.deleteFile(selectedProject, path),
    onSuccess: async () => {
      setSelectedPath("");
      setEditorContent("");
      await qc.invalidateQueries({ queryKey: ["coding", "files", selectedProject] });
    },
  });

  const uploadFile = useMutation({
    mutationFn: async (file: File) => {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const raw = String(reader.result ?? "");
          resolve(raw.includes(",") ? (raw.split(",")[1] ?? "") : raw);
        };
        reader.onerror = () => reject(new Error("File could not be read"));
        reader.readAsDataURL(file);
      });
      return api.coding.uploadFile(selectedProject, { fileName: file.name, contentBase64: base64 });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["coding", "files", selectedProject] });
    },
  });

  const hasChanges = Boolean(
    selectedItem?.type === "file" &&
      readFileQuery.data?.isText &&
      (readFileQuery.data.content ?? "") !== editorContent
  );

  const lastChatOutput = useMemo(() => {
    const fromBottom = [...messages].reverse();
    const nonUser = fromBottom.find((msg) => msg.role !== "user");
    return nonUser ?? fromBottom[0] ?? null;
  }, [messages]);

  const createProjectFromModal = () => {
    const name = newProjectName.trim();
    if (!name) return;
    createProject.mutate(name);
  };

  const handleUploadFromModal = async () => {
    if (!selectedProject || uploadFiles.length === 0) return;
    for (const file of uploadFiles) {
      await uploadFile.mutateAsync(file);
    }
    setUploadFiles([]);
    setShowUploadModal(false);
  };

  const previewType = useMemo<"html" | "image" | "text" | "none">(() => {
    if (!selectedPath || selectedItem?.type !== "file") return "none";
    if (isHtmlFile(selectedPath) && readFileQuery.data?.isText) return "html";
    if (isImageFile(selectedPath) && !readFileQuery.data?.isText && Boolean(readFileQuery.data?.contentBase64)) return "image";
    if (readFileQuery.data?.isText) return "text";
    return "none";
  }, [readFileQuery.data?.contentBase64, readFileQuery.data?.isText, selectedItem?.type, selectedPath]);

  const imagePreviewSrc = useMemo(() => {
    if (previewType !== "image" || !selectedPath || !readFileQuery.data?.contentBase64) return "";
    const ext = getFileExtension(selectedPath);
    const mime = ext === "jpg" ? "jpeg" : ext;
    return `data:image/${mime};base64,${readFileQuery.data.contentBase64}`;
  }, [previewType, readFileQuery.data?.contentBase64, selectedPath]);

  const sendCodingPrompt = async () => {
    const text = chatInput.trim();
    if (!text || !selectedProject) return;

    setIsEnsuringConversation(true);
    let ensuredConversationId = activeConversationId;

    try {
      if (ensuredConversationId) {
        try {
          await api.chat.getMessages(ensuredConversationId);
        } catch (error) {
          if (isConversationNotFoundError(error)) {
            setProjectConversationMap((prev) => {
              if (prev[selectedProject] !== ensuredConversationId) return prev;
              const next = { ...prev };
              delete next[selectedProject];
              return next;
            });
            ensuredConversationId = undefined;
          } else {
            throw error;
          }
        }
      }

      if (!ensuredConversationId) {
        const created = await api.chat.createConversation({ name: `[Coding] ${selectedProject}` });
        ensuredConversationId = created.conversationId;
        setProjectConversationMap((prev) => ({
          ...prev,
          [selectedProject]: ensuredConversationId as number,
        }));
      }

      setConversationId(ensuredConversationId);
    } catch {
      setIsEnsuringConversation(false);
      return;
    }

    const contextPrefix = [
      "[CODING_CONTEXT]",
      `project=${selectedProject || "none"}`,
      `workspaceRoot=shared-workspace/coding/${selectedProject || ""}`,
      "Use files only inside this coding project.",
      "",
      text,
    ].join("\n");

    sendMessage(contextPrefix);
    setChatInput("");
    setIsEnsuringConversation(false);
  };

  if (!codingSettingReady) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-2">{t("codingPage.title")}</h1>
        <p className="text-sm text-gray-400">{t("app.loadingPage")}</p>
      </div>
    );
  }

  if (!codingEnabled) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-2">{t("codingPage.title")}</h1>
        <p className="text-sm text-gray-400">{t("codingPage.disabled")}</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4 h-full">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("codingPage.title")}</h1>
          <p className="text-sm text-gray-400">{t("codingPage.subtitle")}</p>
          <p className="text-xs text-gray-500 mt-1">{t("codingPage.sharedHint")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn-secondary flex items-center gap-2"
            onClick={() => setShowUploadModal(true)}
            disabled={!selectedProject}
          >
            <Upload className="w-4 h-4" />
            Upload
          </button>
          <button
            className="btn-primary flex items-center gap-2"
            onClick={() => setShowCreateProjectModal(true)}
          >
            <Plus className="w-4 h-4" />
            {t("codingPage.createProject")}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[320px,1fr] gap-4 h-[calc(100%-108px)] min-h-[620px]">
        <section className="card overflow-hidden flex flex-col">
          {selectedProject ? (
            <div className="min-h-0 flex-1 flex flex-col space-y-2">
              <h2 className="text-sm font-semibold">{t("codingPage.chatTitle")}</h2>
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 min-h-[96px] flex-1 overflow-y-auto">
                {lastChatOutput ? (
                  <>
                    <div className="text-[11px] text-gray-400 mb-1">{lastChatOutput.role}</div>
                    <div className="whitespace-pre-wrap break-words text-sm">{lastChatOutput.content}</div>
                  </>
                ) : (
                  <p className="text-sm text-gray-500">Noch keine Chat-Ausgabe vorhanden.</p>
                )}
              </div>

              <textarea
                className="input w-full min-h-20"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder={t("codingPage.chatPlaceholder")}
              />
              <button
                className="btn-primary w-full"
                onClick={() => {
                  void sendCodingPrompt();
                }}
                disabled={!chatInput.trim() || isLoading || isEnsuringConversation}
              >
                <Send className="w-4 h-4 inline mr-1" />
                {t("codingPage.send")}
              </button>
            </div>
          ) : (
            <p className="text-sm text-gray-500">{t("codingPage.noProjects")}</p>
          )}
        </section>

        <section className="min-h-0 flex flex-col">
          <div className="card flex-1 min-h-0 flex flex-col">
            {!selectedPath && <p className="text-gray-500">{t("codingPage.selectFile")}</p>}

            {selectedPath && selectedItem?.type === "file" && (
              <>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <h2 className="text-lg font-semibold truncate">{selectedPath}</h2>
                  <div className="flex items-center gap-2">
                    <button
                      className="btn-secondary"
                      onClick={() => moveFile.mutate({ fromPath: selectedPath, toPath: moveTarget.trim() })}
                      disabled={!moveTarget.trim() || moveTarget.trim() === selectedPath || moveFile.isPending}
                      title={t("codingPage.moveFile")}
                    >
                      <ArrowRightLeft className="w-4 h-4" />
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => setShowPreviewModal(true)}
                      disabled={previewType === "none"}
                      title={t("codingPage.previewFile")}
                    >
                      <Eye className="w-4 h-4 inline mr-1" />
                      {t("codingPage.previewFile")}
                    </button>
                    <button
                      className="btn-secondary text-red-300"
                      onClick={() => deleteFile.mutate(selectedPath)}
                      disabled={deleteFile.isPending}
                    >
                      <Trash2 className="w-4 h-4 inline mr-1" />
                      {t("codingPage.deleteFile")}
                    </button>
                    <button
                      className="btn-primary"
                      onClick={() => writeFile.mutate({ path: selectedPath, content: editorContent })}
                      disabled={!hasChanges || writeFile.isPending}
                    >
                      <Save className="w-4 h-4 inline mr-1" />
                      {t("codingPage.saveFile")}
                    </button>
                  </div>
                </div>

                <div className="mb-3">
                  <input
                    className="input w-full"
                    value={moveTarget}
                    onChange={(e) => setMoveTarget(e.target.value)}
                    placeholder={t("codingPage.moveFile")}
                  />
                </div>

                {readFileQuery.data?.isText ? (
                  <div className="border border-gray-800 rounded-lg overflow-hidden flex-1 min-h-[520px]">
                    <Editor
                      height="100%"
                      language={detectLanguage(selectedPath)}
                      value={editorContent}
                      onChange={(value) => setEditorContent(value ?? "")}
                      options={{
                        minimap: { enabled: true },
                        fontSize: 13,
                        wordWrap: "on",
                        automaticLayout: true,
                        tabSize: 2,
                        smoothScrolling: true,
                        scrollBeyondLastLine: false,
                      }}
                      theme="vs-dark"
                    />
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">Binary file preview not available.</p>
                )}
              </>
            )}
          </div>

        </section>
      </div>

      {showCreateProjectModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl border border-gray-800 bg-gray-950 shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <h2 className="text-lg font-semibold">{t("codingPage.createProject")}</h2>
              <button className="text-gray-400 hover:text-white" onClick={() => setShowCreateProjectModal(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <input
                className="input w-full"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder={t("codingPage.projectPlaceholder")}
              />
              <div className="flex justify-end gap-2">
                <button className="btn-secondary" onClick={() => setShowCreateProjectModal(false)}>
                  {t("common.cancel")}
                </button>
                <button
                  className="btn-primary"
                  onClick={createProjectFromModal}
                  disabled={!newProjectName.trim() || createProject.isPending}
                >
                  {t("common.create")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showUploadModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-xl border border-gray-800 bg-gray-950 shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <h2 className="text-lg font-semibold">Upload</h2>
              <button className="text-gray-400 hover:text-white" onClick={() => setShowUploadModal(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-gray-400">Projekt: {selectedProject || "-"}</p>
              <input
                type="file"
                multiple
                className="input w-full"
                onChange={(e) => setUploadFiles(Array.from(e.target.files ?? []))}
              />
              <p className="text-xs text-gray-500">{uploadFiles.length} Datei(en) ausgewaehlt</p>
              <div className="flex justify-end gap-2">
                <button className="btn-secondary" onClick={() => setShowUploadModal(false)}>
                  {t("common.cancel")}
                </button>
                <button
                  className="btn-primary"
                  onClick={() => {
                    void handleUploadFromModal();
                  }}
                  disabled={uploadFiles.length === 0 || uploadFile.isPending || !selectedProject}
                >
                  Upload
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showPreviewModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-6xl h-[85vh] rounded-xl border border-gray-800 bg-gray-950 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <h2 className="text-lg font-semibold truncate">{t("codingPage.previewFile")}: {selectedPath}</h2>
              <button className="text-gray-400 hover:text-white" onClick={() => setShowPreviewModal(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 flex-1 min-h-0 overflow-hidden">
              {previewType === "html" && (
                <iframe
                  title="coding-html-preview"
                  srcDoc={readFileQuery.data?.content ?? ""}
                  className="w-full h-full rounded-lg border border-gray-800 bg-white"
                />
              )}

              {previewType === "image" && (
                <div className="w-full h-full flex items-center justify-center rounded-lg border border-gray-800 bg-gray-900">
                  <img src={imagePreviewSrc} alt={selectedPath} className="max-w-full max-h-full object-contain" />
                </div>
              )}

              {previewType === "text" && (
                <pre className="w-full h-full overflow-auto rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-100 whitespace-pre-wrap">
                  {readFileQuery.data?.content ?? ""}
                </pre>
              )}

              {previewType === "none" && (
                <div className="w-full h-full flex items-center justify-center rounded-lg border border-gray-800 bg-gray-900">
                  <p className="text-sm text-gray-400">{t("codingPage.previewUnavailable")}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
