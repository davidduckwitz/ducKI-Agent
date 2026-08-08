import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerQuery } from "../../lib/useServerQuery";
import { useSettings, readFlag, settingsReady } from "../../lib/useSettings";
import {
  Columns2,
  FileCode2,
  Maximize2,
  PanelRightOpen,
  Pencil,
  Plus,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import Editor from "@monaco-editor/react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useAppStore } from "../../lib/store";
import { useCodingSession } from "../../lib/codingSessionStore";
import { useUiStore, CODING_AGENT_MIN_WIDTH, CODING_AGENT_MAX_WIDTH } from "../../lib/uiStore";
import { useTheme } from "../theme/ThemeProvider";
import { extractChangedFiles } from "../../lib/extractChangedFiles";
import { PanelEmpty } from "../ui/panel";
import { SplitHandle } from "../ui/split-handle";
import { CodingEditorTabs } from "./CodingEditorTabs";
import { CodingAgentPanel } from "./CodingAgentPanel";
import { PlanExecutionPanel, type Plan, type StepStatus } from "../chat/PlanExecutionPanel";
import type { CodingFileItem } from "./CodingFileTree";
import type { AgentEventType, RenderedChatMessage } from "../chat/chatTypes";

interface PersistedMessage {
  id: number;
  role: "user" | "assistant" | "system" | "tool" | "event";
  content: string;
  metadata?: string | null;
  toolResult?: string | null;
  createdAt: string;
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
  const { resolvedMode } = useTheme();
  const { messages, sendMessage, isLoading, streamingContent, setConversationId, setMessages } = useAppStore();
  const creatingConversationRef = useRef<Record<string, boolean>>({});

  const {
    selectedProject,
    setSelectedProject,
    selectedPath,
    openPaths,
    openFile,
    closeFile,
    drafts,
    setDraft,
    clearDraft,
    renamePath,
    command,
  } = useCodingSession();
  const {
    codingAgentOpen,
    codingAgentWidth,
    codingSplitPreview,
    setCodingAgentOpen,
    setCodingAgentWidth,
    setCodingSplitPreview,
    setCodingAgentTab,
  } = useUiStore();

  // A plan created in the chat page hands itself over via router state on the
  // auto-switch to /coding. The coding Plan panel otherwise derives its plan from
  // the coding project's own conversation, which never contains that chat plan.
  const location = useLocation();
  const navigate = useNavigate();
  const [handoffPlan, setHandoffPlan] = useState<Plan | null>(null);
  useEffect(() => {
    const incoming = (location.state as { handoffPlan?: Plan } | null)?.handoffPlan;
    if (incoming && incoming.goal && Array.isArray(incoming.steps)) {
      setHandoffPlan(incoming);
      setCodingAgentOpen(true);
      setCodingAgentTab("plan");
      // Consume the state so it isn't re-applied on back/forward or reload.
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  // Auto-open the most recently written file in the editor. We open only the LAST
  // changed file (not every one) to avoid spamming tabs / stealing focus on
  // multi-file runs, and refresh the tree + content so it shows the fresh bytes.
  const autoOpenedRef = useRef<string>("");
  useEffect(() => {
    if (!selectedProject) return;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== "assistant") continue;
      const files = extractChangedFiles(typeof m.content === "string" ? m.content : "");
      if (files.length === 0) continue;
      const latest = files[files.length - 1];
      const key = `${m.id}:${latest}`;
      if (latest && autoOpenedRef.current !== key) {
        autoOpenedRef.current = key;
        openFile(latest);
        void qc.invalidateQueries({ queryKey: ["coding", "files", selectedProject] });
        void qc.invalidateQueries({ queryKey: ["coding", "read", selectedProject, latest] });
      }
      break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, selectedProject]);

  const [newProjectName, setNewProjectName] = useState("");
  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [showPlanPanel, setShowPlanPanel] = useState(false);
  const lastPlanIdRef = useRef<number | undefined>();
  const [renaming, setRenaming] = useState(false);
  const [renameTarget, setRenameTarget] = useState("");
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [isEnsuringConversation, setIsEnsuringConversation] = useState(false);

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

  const settingsQuery = useSettings();
  const codingEnabled = readFlag(settingsQuery.data, "CODING_ENABLED");
  const codingSettingReady = settingsReady(settingsQuery);

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

    const mapped: RenderedChatMessage[] = persisted.map((msg) => {
      const metadata = parseMessageMetadata(msg.metadata);
      if (msg.role === "event") {
        let eventType: AgentEventType | undefined;
        let eventData: Record<string, unknown> | undefined;

        if (msg.toolResult) {
          try {
            const parsed = JSON.parse(msg.toolResult) as { eventType?: string; data?: Record<string, unknown> };
            const type = parsed.eventType;
            if (
              type === "plan" ||
              type === "iteration" ||
              type === "tool_call" ||
              type === "tool_result" ||
              type === "reasoning" ||
              type === "decision" ||
              type === "guardrail" ||
              type === "skill_selection" ||
              type === "tool_retry" ||
              type === "mode_selected" ||
              type === "browser_preview" ||
              type === "thinking" ||
              type === "internal_instruction"
            ) {
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

    // Synthetic follow-up prompts (metadata.internal) already showed a translated status
    // note as an internal_instruction event above - don't also render the raw prompt.
    setMessages(mapped.filter((m) => !(m.role === "user" && m.metadata?.internal === true)) as never);
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

  const projectsQuery = useQuery({
    queryKey: ["coding", "projects"],
    queryFn: () => api.coding.listProjects() as Promise<Array<{ slug: string; name: string }>>,
    enabled: codingSettingReady && codingEnabled,
  });

  useEffect(() => {
    if (!selectedProject) return;
    const last = messages[messages.length - 1];
    if (!last) return;
    if (last.role === "user") return;
    // Reload files list when agent responds
    void qc.invalidateQueries({ queryKey: ["coding", "files", selectedProject] });
    if (selectedPath) {
      void qc.invalidateQueries({ queryKey: ["coding", "read", selectedProject, selectedPath] });
    }
  }, [messages, qc, selectedProject, selectedPath]);

  const selectedItem = useMemo(
    () => (filesQuery.data?.files ?? []).find((file) => file.path === selectedPath),
    [filesQuery.data?.files, selectedPath]
  );

  const readFileQuery = useQuery({
    queryKey: ["coding", "read", selectedProject, selectedPath],
    queryFn: () => api.coding.readFile(selectedProject, selectedPath),
    enabled: codingSettingReady && codingEnabled && Boolean(selectedProject && selectedPath),
  });

  const savedContent = readFileQuery.data?.isText ? (readFileQuery.data.content ?? "") : "";
  const draft = drafts[selectedPath];
  const editorContent = draft ?? savedContent;
  const hasChanges = draft !== undefined && draft !== savedContent;
  const dirtyPaths = useMemo(
    () => new Set(Object.entries(drafts).filter(([, value]) => value !== undefined).map(([key]) => key)),
    [drafts]
  );

  // Extract current plan from messages for modal display
  const currentPlan = useMemo(() => {
    const msgs = messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const msg = msgs[i];
      if (!msg || msg.eventType !== "plan" || !msg.eventData) continue;
      const data = msg.eventData as unknown as Plan;
      if (data.goal && Array.isArray(data.steps) && data.steps.length > 0) return data;
    }
    return null;
  }, [messages]);

  useEffect(() => {
    setRenaming(false);
    setRenameTarget(selectedPath);
  }, [selectedPath]);

  // Auto-show plan modal when a NEW plan appears (only once per plan)
  useEffect(() => {
    if (currentPlan && currentPlan.id !== lastPlanIdRef.current) {
      lastPlanIdRef.current = currentPlan.id;
      setShowPlanPanel(true);
    }
  }, [currentPlan?.id]);

  const createProject = useMutation({
    mutationFn: (name: string) => api.coding.createProject(name),
    onSuccess: async (data: { created: boolean; slug: string; path: string }) => {
      setNewProjectName("");
      setShowCreateProjectModal(false);

      // First refetch projects to ensure the new project is in the list
      await qc.invalidateQueries({ queryKey: ["coding", "projects"] });
      // Then select it after refetch completes
      await qc.refetchQueries({ queryKey: ["coding", "projects"] });

      // Now set the selected project
      setSelectedProject(data.slug);

      // Load files for the new project
      await qc.invalidateQueries({ queryKey: ["coding", "files", data.slug] });
    },
    onError: (error) => {
      console.error("Failed to create project:", error);
      // Keep modal open on error so user can try again
    },
  });

  const writeFile = useMutation({
    mutationFn: (payload: { path: string; content: string }) =>
      api.coding.writeFile(selectedProject, payload.path, payload.content),
    onSuccess: async (_data, vars) => {
      clearDraft(vars.path);
      openFile(vars.path);
      await qc.invalidateQueries({ queryKey: ["coding", "files", selectedProject] });
      await qc.invalidateQueries({ queryKey: ["coding", "read", selectedProject, vars.path] });
    },
  });

  const moveFile = useMutation({
    mutationFn: (payload: { fromPath: string; toPath: string }) =>
      api.coding.moveFile(selectedProject, payload.fromPath, payload.toPath),
    onSuccess: async (result, vars) => {
      renamePath(vars.fromPath, result.toPath);
      setRenaming(false);
      await qc.invalidateQueries({ queryKey: ["coding", "files", selectedProject] });
      await qc.invalidateQueries({ queryKey: ["coding", "read", selectedProject, result.toPath] });
    },
  });

  const deleteFile = useMutation({
    mutationFn: (path: string) => api.coding.deleteFile(selectedProject, path),
    onSuccess: async (_data, path) => {
      closeFile(path);
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

  const saveActiveFile = useCallback(() => {
    if (!selectedPath || !hasChanges || writeFile.isPending) return;
    writeFile.mutate({ path: selectedPath, content: editorContent });
  }, [editorContent, hasChanges, selectedPath, writeFile]);

  // Ctrl/Cmd+S anywhere in the workspace saves the active tab.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      saveActiveFile();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveActiveFile]);

  // Commands from the sidebar's "Neu" menu / explorer header.
  const handledCommandNonce = useRef(-1);
  useEffect(() => {
    if (command.nonce === handledCommandNonce.current) return;
    handledCommandNonce.current = command.nonce;
    if (command.action === "new-project") setShowCreateProjectModal(true);
    if (command.action === "upload") setShowUploadModal(true);
  }, [command.nonce, command.action]);

  const previewType = useMemo<"html" | "image" | "markdown" | "text" | "none">(() => {
    if (!selectedPath) return "none";
    if (isHtmlFile(selectedPath) && readFileQuery.data?.isText) return "html";
    if (isImageFile(selectedPath) && !readFileQuery.data?.isText && Boolean(readFileQuery.data?.contentBase64))
      return "image";
    if (getFileExtension(selectedPath) === "md" && readFileQuery.data?.isText) return "markdown";
    if (readFileQuery.data?.isText) return "text";
    return "none";
  }, [readFileQuery.data?.contentBase64, readFileQuery.data?.isText, selectedPath]);

  const imagePreviewSrc = useMemo(() => {
    if (previewType !== "image" || !selectedPath || !readFileQuery.data?.contentBase64) return "";
    const ext = getFileExtension(selectedPath);
    const mime = ext === "jpg" ? "jpeg" : ext;
    return `data:image/${mime};base64,${readFileQuery.data.contentBase64}`;
  }, [previewType, readFileQuery.data?.contentBase64, selectedPath]);

  const handleUploadFromModal = async () => {
    if (!selectedProject || uploadFiles.length === 0) return;
    for (const file of uploadFiles) {
      await uploadFile.mutateAsync(file);
    }
    setUploadFiles([]);
    setShowUploadModal(false);
  };

  const sendCodingPrompt = async (text: string, options: { planMode: boolean; includeFile: string | null }) => {
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
      ...(options.includeFile ? [`activeFile=${options.includeFile}`] : []),
      "Use files only inside this coding project.",
      "",
      text,
    ].join("\n");

    void sendMessage(contextPrefix, undefined, options.planMode ? "plan" : undefined, text);
    setIsEnsuringConversation(false);
  };

  // Robust plan execution: guarantees a coding project + conversation exist before
  // running, so "Execute" works even for a plan handed over from chat with nothing
  // selected yet. The project slug travels to the backend so files land in its sandbox.
  const executePlan = async (plan: Plan) => {
    let project = selectedProject;
    if (!project) {
      const base = String(plan.goal || plan.title || "plan").trim();
      const name = (base.slice(0, 40) || `plan-${Date.now()}`);
      const created = await api.coding.createProject(name);
      project = created.slug;
      setSelectedProject(project);
    }

    let convId = projectConversationMap[project];
    if (!convId) {
      const created = await api.chat.createConversation({ name: `[Coding] ${project}` });
      convId = created.conversationId;
      const ensuredProject = project;
      setProjectConversationMap((prev) => ({ ...prev, [ensuredProject]: convId as number }));
      setConversationId(convId);
    }

    const steps = (plan.steps ?? []).map((s) => ({
      title: s.title,
      description: s.description ?? "",
      tools: s.tools,
    }));

    await api.plans.execute(plan.id, {
      goal: plan.goal,
      steps,
      markdown: plan.markdown,
      conversationId: convId,
      projectSlug: project,
    });
  };

  if (!codingSettingReady) {
    return (
      <div className="page">
        <h1 className="text-2xl font-bold">{t("codingPage.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("app.loadingPage")}</p>
      </div>
    );
  }

  if (!codingEnabled) {
    return (
      <div className="page">
        <h1 className="text-2xl font-bold">{t("codingPage.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("codingPage.disabled")}</p>
      </div>
    );
  }

  const showEditor = Boolean(selectedPath);
  const isTextFile = readFileQuery.data?.isText ?? false;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/50 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileCode2 className="h-4 w-4 shrink-0 text-primary" />
          <select
            className="input max-w-[180px] shrink-0 px-2 py-1 text-xs"
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
          >
            {(projectsQuery.data ?? []).length === 0 && <option value="">{t("codingPage.noProjects")}</option>}
            {(projectsQuery.data ?? []).map((project) => (
              <option key={project.slug} value={project.slug}>
                {project.slug}
              </option>
            ))}
          </select>

          {renaming ? (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <input
                autoFocus
                className="input min-w-0 flex-1 py-1 text-xs"
                value={renameTarget}
                onChange={(e) => setRenameTarget(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && renameTarget.trim() && renameTarget.trim() !== selectedPath) {
                    moveFile.mutate({ fromPath: selectedPath, toPath: renameTarget.trim() });
                  }
                  if (e.key === "Escape") setRenaming(false);
                }}
                placeholder={t("codingPage.renamePlaceholder")}
              />
              <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setRenaming(false)}>
                {t("common.cancel")}
              </button>
            </div>
          ) : (
            selectedPath && (
              <button
                type="button"
                onClick={() => setRenaming(true)}
                title={t("codingPage.rename")}
                className="group flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                <span className="truncate">{selectedPath}</span>
                <Pencil className="h-3 w-3 shrink-0 opacity-0 transition group-hover:opacity-100" />
              </button>
            )
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            className={`rounded-md border border-border p-1.5 transition hover:bg-accent ${
              codingSplitPreview ? "border-primary/50 bg-primary/10 text-primary" : "text-muted-foreground"
            }`}
            onClick={() => setCodingSplitPreview(!codingSplitPreview)}
            disabled={previewType === "none"}
            title={t("codingPage.splitPreview")}
          >
            <Columns2 className="h-3.5 w-3.5" />
          </button>
          <button
            className="rounded-md border border-border p-1.5 text-muted-foreground transition hover:bg-accent disabled:opacity-40"
            onClick={() => setShowPreviewModal(true)}
            disabled={previewType === "none"}
            title={t("codingPage.fullscreenPreview")}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button
            className="rounded-md border border-border p-1.5 text-muted-foreground transition hover:bg-accent disabled:opacity-40"
            onClick={() => setShowUploadModal(true)}
            disabled={!selectedProject}
            title={t("codingPage.uploadTitle")}
          >
            <Upload className="h-3.5 w-3.5" />
          </button>
          <button
            className="rounded-md border border-border p-1.5 text-muted-foreground transition hover:bg-accent hover:text-destructive disabled:opacity-40"
            onClick={() => {
              if (!selectedPath) return;
              if (!window.confirm(`${t("codingPage.deleteFileConfirm")}\n\n${selectedPath}`)) return;
              deleteFile.mutate(selectedPath);
            }}
            disabled={!selectedPath || deleteFile.isPending}
            title={t("codingPage.deleteFile")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            className="btn-primary px-2.5 py-1.5 text-xs"
            onClick={saveActiveFile}
            disabled={!hasChanges || writeFile.isPending}
            title={`${t("codingPage.saveFile")} (Ctrl+S)`}
          >
            <Save className="mr-1 inline h-3.5 w-3.5" />
            {t("codingPage.saveFile")}
          </button>
          {!codingAgentOpen && (
            <button
              className="rounded-md border border-border p-1.5 text-muted-foreground transition hover:bg-accent"
              onClick={() => setCodingAgentOpen(true)}
              title={t("codingPage.showAgentPanel")}
            >
              <PanelRightOpen className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Editor + agent panel */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <CodingEditorTabs
            openPaths={openPaths}
            activePath={selectedPath}
            dirtyPaths={dirtyPaths}
            onSelect={openFile}
            onClose={closeFile}
          />

          {!showEditor ? (
            <PanelEmpty
              icon={<FileCode2 className="h-10 w-10" />}
              title={t("codingPage.noFileOpen")}
              hint={selectedProject ? t("codingPage.noFileOpenHint") : t("codingPage.noProjects")}
            />
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="min-h-0 min-w-0 flex-1">
                {isTextFile ? (
                  <Editor
                    height="100%"
                    path={`${selectedProject}/${selectedPath}`}
                    language={detectLanguage(selectedPath)}
                    value={editorContent}
                    onChange={(value) => setDraft(selectedPath, value ?? "")}
                    options={{
                      minimap: { enabled: true },
                      fontSize: 13,
                      wordWrap: "on",
                      automaticLayout: true,
                      tabSize: 2,
                      smoothScrolling: true,
                      scrollBeyondLastLine: false,
                    }}
                    theme={resolvedMode === "dark" ? "vs-dark" : "light"}
                  />
                ) : (
                  <PanelEmpty icon={<FileCode2 className="h-10 w-10" />} title={t("codingPage.binaryFile")} />
                )}
              </div>

              {codingSplitPreview && previewType !== "none" && (
                <div className="flex min-h-0 w-1/2 min-w-0 flex-col border-l border-border">
                  <div className="shrink-0 border-b border-border px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
                    {t("codingPage.previewFile")}
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto bg-background/40">
                    {previewType === "html" && (
                      <iframe title="coding-html-preview" srcDoc={editorContent} className="h-full w-full bg-white" />
                    )}
                    {previewType === "image" && (
                      <div className="flex h-full items-center justify-center p-3">
                        <img src={imagePreviewSrc} alt={selectedPath} className="max-h-full max-w-full object-contain" />
                      </div>
                    )}
                    {(previewType === "text" || previewType === "markdown") && (
                      <pre className="whitespace-pre-wrap p-3 text-xs leading-relaxed">{editorContent}</pre>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {codingAgentOpen && (
          <>
            <SplitHandle
              value={codingAgentWidth}
              onChange={setCodingAgentWidth}
              ariaLabel={t("codingPage.agentPanel")}
            />
            <div
              className="flex min-h-0 shrink-0 flex-col border-l border-border bg-card/40"
              style={{
                width: `${codingAgentWidth}px`,
                minWidth: `${CODING_AGENT_MIN_WIDTH}px`,
                maxWidth: `${CODING_AGENT_MAX_WIDTH}px`,
              }}
            >
              <CodingAgentPanel
                messages={messages as RenderedChatMessage[]}
                isLoading={isLoading || isEnsuringConversation}
                streamingContent={streamingContent}
                conversationId={activeConversationId}
                activeFilePath={selectedPath}
                disabled={!selectedProject}
                overridePlan={handoffPlan}
                onExecutePlan={executePlan}
                onOpenFile={openFile}
                onSend={(text, options) => {
                  void sendCodingPrompt(text, options);
                }}
              />
            </div>
          </>
        )}
      </div>

      {showCreateProjectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-lg font-semibold">{t("codingPage.createProject")}</h2>
              <button className="rounded p-1 hover:bg-accent" onClick={() => setShowCreateProjectModal(false)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <input
                autoFocus
                className="input w-full"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newProjectName.trim()) createProject.mutate(newProjectName.trim());
                }}
                placeholder={t("codingPage.projectPlaceholder")}
              />
              <div className="flex justify-end gap-2">
                <button className="btn-secondary" onClick={() => setShowCreateProjectModal(false)}>
                  {t("common.cancel")}
                </button>
                <button
                  className="btn-primary"
                  onClick={() => createProject.mutate(newProjectName.trim())}
                  disabled={!newProjectName.trim() || createProject.isPending}
                >
                  <Plus className="mr-1 inline h-4 w-4" />
                  {t("common.create")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-xl rounded-xl border border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-lg font-semibold">{t("codingPage.uploadTitle")}</h2>
              <button className="rounded p-1 hover:bg-accent" onClick={() => setShowUploadModal(false)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <p className="text-sm text-muted-foreground">
                {t("codingPage.project")}: {selectedProject || "-"}
              </p>
              <input
                type="file"
                multiple
                className="input w-full"
                onChange={(e) => setUploadFiles(Array.from(e.target.files ?? []))}
              />
              <p className="text-xs text-muted-foreground">
                {uploadFiles.length} {t("codingPage.filesSelected")}
              </p>
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
                  <Upload className="mr-1 inline h-4 w-4" />
                  Upload
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showPreviewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="flex h-[85vh] w-full max-w-6xl flex-col rounded-xl border border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="truncate text-lg font-semibold">
                {t("codingPage.previewFile")}: {selectedPath}
              </h2>
              <button className="rounded p-1 hover:bg-accent" onClick={() => setShowPreviewModal(false)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden p-4">
              {previewType === "html" && (
                <iframe
                  title="coding-html-preview-full"
                  srcDoc={editorContent}
                  className="h-full w-full rounded-lg border border-border bg-white"
                />
              )}
              {previewType === "image" && (
                <div className="flex h-full w-full items-center justify-center rounded-lg border border-border bg-background/50">
                  <img src={imagePreviewSrc} alt={selectedPath} className="max-h-full max-w-full object-contain" />
                </div>
              )}
              {(previewType === "text" || previewType === "markdown") && (
                <pre className="h-full w-full overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background/50 p-4 text-sm">
                  {editorContent}
                </pre>
              )}
              {previewType === "none" && (
                <div className="flex h-full w-full items-center justify-center rounded-lg border border-border bg-background/50">
                  <p className="text-sm text-muted-foreground">{t("codingPage.previewUnavailable")}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Plan Execution Panel Modal - only show before execution starts */}
      {showPlanPanel && currentPlan && (
        <PlanExecutionPanel
          plan={currentPlan}
          onRefine={() => {
            setShowPlanPanel(false);
            const planText = currentPlan.markdown || JSON.stringify(currentPlan.steps, null, 2);
            sendMessage(
              `Verbessere diesen Plan: ${currentPlan.goal}\n\nBisheriger Plan:\n${planText}`,
              undefined,
              "plan",
              ""
            );
          }}
          onExecute={() => {
            setShowPlanPanel(false);
            // The plan execution is handled by the agent sending the command
            sendMessage("Umsetzen", undefined, undefined, "");
          }}
          onClose={() => setShowPlanPanel(false)}
          isExecuting={isLoading}
        />
      )}
    </div>
  );
}
