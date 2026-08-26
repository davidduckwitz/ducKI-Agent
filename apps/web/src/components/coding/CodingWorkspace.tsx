import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerQuery } from "../../lib/useServerQuery";
import { useSettings, readFlag, settingsReady } from "../../lib/useSettings";
import {
  Columns2,
  FileCode2,
  Globe,
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
import { useIsMobile } from "../../lib/useMediaQuery";
import { useTheme } from "../theme/ThemeProvider";
import { extractChangedFiles } from "../../lib/extractChangedFiles";
import { toastManager } from "../../lib/toast";
import { PanelEmpty } from "../ui/panel";
import { SplitHandle } from "../ui/split-handle";
import { CodingEditorTabs } from "./CodingEditorTabs";
import { CodingAgentPanel } from "./CodingAgentPanel";
import { PlanExecutionPanel, type Plan, type StepStatus } from "../chat/PlanExecutionPanel";
import type { CodingFileItem } from "./CodingFileTree";
import type { RenderedChatMessage } from "../chat/chatTypes";
import { parsePersistedEvent } from "../../lib/persistedEventTypes";

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

/**
 * Derives a project name for auto-creation that is virtually guaranteed unique. The
 * backend's createProject is idempotent-by-slug (it happily reuses an existing directory
 * instead of erroring), so a name derived only from a plan's goal/title can silently
 * collide with an unrelated pre-existing project - a fresh plan handoff or "Execute"
 * would then land in that stale project instead of a genuinely new, empty one. Appending
 * a short time-based suffix keeps the name readable while avoiding that collision.
 */
function uniqueProjectNameFrom(base: string): string {
  const trimmed = base.trim().slice(0, 40);
  const suffix = Date.now().toString(36).slice(-6);
  return trimmed ? `${trimmed}-${suffix}` : `plan-${suffix}`;
}

export function CodingWorkspace() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { resolvedMode } = useTheme();
  const { messages, sendMessage, stopMessage, isLoading, streamingContent, setConversationId, setMessages, chatProvider, chatModel } = useAppStore();
  // One in-flight promise per project slug. A boolean "am I creating?" flag only ever
  // protected the effect below from itself; the other two callers (sendCodingPrompt,
  // executePlan) checked the resolved map instead and happily started a SECOND create while
  // the first was still in flight. Handing every caller the same promise makes a duplicate
  // structurally impossible rather than merely unlikely.
  const creatingConversationRef = useRef<Record<string, Promise<number>>>({});
  // Projects deleted in this session. A deleted project must never get a conversation again,
  // and the selection effect can still be holding its slug for one render after the delete.
  const deletedProjectsRef = useRef<Set<string>>(new Set());

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
  const isNarrow = useIsMobile();

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

      // A plan handed off from chat must land in its OWN fresh coding project - leaving
      // whatever project was selected before (from a previous session) showed this plan
      // next to a stale, unrelated file tree and conversation. Mirrors executePlan()'s own
      // auto-create fallback below, just triggered on arrival instead of on "Execute".
      void (async () => {
        try {
          const name = uniqueProjectNameFrom(String(incoming.goal || incoming.title || "plan"));
          const created = await api.coding.createProject(name);
          // The project selector's options come from this cached query - without
          // refetching it, selectedProject points at a slug the dropdown doesn't list yet,
          // so the switch doesn't visibly happen even though the state is set correctly.
          await qc.invalidateQueries({ queryKey: ["coding", "projects"] });
          await qc.refetchQueries({ queryKey: ["coding", "projects"] });
          setSelectedProject(created.slug);
        } catch {
          // Non-critical - the plan still renders via handoffPlan/overridePlan even if
          // auto-creation failed here; execute() creates a project lazily as a fallback.
        }
      })();
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
  const [projectToDelete, setProjectToDelete] = useState<string | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  /**
   * false (default): the preview iframe uses `srcDoc` with the in-editor content - instant,
   * reflects unsaved edits, but has no real URL/origin so relative asset references
   * (<script src="./app.js">, <link href="style.css">) never resolve.
   * true: the iframe loads the file over real HTTP (api.coding.previewUrl) instead - relative
   * references resolve correctly for multi-file HTML/CSS/JS, at the cost of only reflecting the
   * last SAVED version (the server reads from disk, not from the editor's draft).
   */
  const [useRealPreview, setUseRealPreview] = useState(false);
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

  // Mirror of the map that is readable (and writable) SYNCHRONOUSLY. React state only becomes
  // visible on the next render, which is exactly the window in which a second caller would
  // otherwise still see "no conversation for this project" and create another one.
  //
  // Seeded from the persisted state once and then maintained by the only two functions that
  // change the mapping (ensureProjectConversation and forgetProjectConversation), which both
  // write here BEFORE calling setProjectConversationMap. Re-assigning it from state on every
  // render would be the one thing that can undo such a synchronous write - between the write
  // and React processing the state update, a render would put the stale map back and the next
  // caller would create a duplicate after all.
  const projectConversationMapRef = useRef(projectConversationMap);

  /** Forget a mapping whose conversation no longer exists server-side, so the next ensure
   *  call creates a fresh one instead of failing against a deleted id forever. */
  const forgetProjectConversation = useCallback((project: string, conversationId: number) => {
    if (projectConversationMapRef.current[project] === conversationId) {
      const next = { ...projectConversationMapRef.current };
      delete next[project];
      projectConversationMapRef.current = next;
    }
    delete creatingConversationRef.current[project];
    setProjectConversationMap((prev) => {
      if (prev[project] !== conversationId) return prev;
      const next = { ...prev };
      delete next[project];
      return next;
    });
  }, []);

  /**
   * The single place a `[Coding] <project>` conversation is created.
   *
   * Three call sites used to create one independently - the selection effect, sending a
   * prompt, and executing a plan - each checking only the already-resolved map. Handing a
   * plan over from chat fires all three within the same tick: the effect starts creating for
   * the freshly-created project, and "Execute" runs before that request comes back, so both
   * create one and the user ends up with two sessions for a single project. Concurrent
   * callers now await the same promise, and the resolved id is written to the synchronous
   * mirror before the promise is cleared, so there is no gap where a caller can miss it.
   */
  const ensureProjectConversation = useCallback(async (project: string): Promise<number> => {
    if (deletedProjectsRef.current.has(project)) {
      throw new Error(`Coding project "${project}" was deleted`);
    }

    const known = projectConversationMapRef.current[project];
    if (known) return known;

    const inFlight = creatingConversationRef.current[project];
    if (inFlight) return inFlight;

    const pending = (async () => {
      const created = await api.chat.createConversation({ name: `[Coding] ${project}` });
      projectConversationMapRef.current = {
        ...projectConversationMapRef.current,
        [project]: created.conversationId,
      };
      setProjectConversationMap((prev) => ({ ...prev, [project]: created.conversationId }));
      return created.conversationId;
    })();

    creatingConversationRef.current[project] = pending;
    try {
      return await pending;
    } finally {
      delete creatingConversationRef.current[project];
    }
  }, []);

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

    void ensureProjectConversation(selectedProject)
      .then((conversationId) => setConversationId(conversationId))
      .catch(() => {
        // Keep UI responsive; user can retry by reselecting project.
      });
  }, [codingSettingReady, codingEnabled, selectedProject, projectConversationMap, setConversationId, ensureProjectConversation]);

  const conversationMessagesQuery = useInfiniteQuery({
    queryKey: ["coding", "conversation", activeConversationId],
    queryFn: ({ pageParam }) =>
      api.chat.getMessagesPage(activeConversationId ?? 0, {
        beforeId: pageParam as number | undefined,
        limit: 40,
      }) as Promise<{ items: PersistedMessage[]; hasMore: boolean; nextBeforeId?: number }>,
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextBeforeId : undefined),
    enabled: codingSettingReady && codingEnabled && Boolean(activeConversationId),
    refetchInterval: 3000,
  });

  const clearCodingMessages = useMutation({
    mutationFn: (id: number) => api.chat.clearMessages(id),
    onSuccess: async (_data, clearedId) => {
      setMessages([] as never);
      qc.removeQueries({ queryKey: ["coding", "conversation", clearedId] });
      await qc.invalidateQueries({ queryKey: ["coding", "conversation", clearedId] });
    },
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
    const pages = conversationMessagesQuery.data?.pages;
    if (!pages) return;
    // Pages are fetched newest-first (beforeId cursor); each page is already sorted
    // ascending internally, so reverse the page order to get full chronological history.
    const persisted = pages.slice().reverse().flatMap((page) => page.items);

    const mapped: RenderedChatMessage[] = persisted.map((msg) => {
      const metadata = parseMessageMetadata(msg.metadata);
      if (msg.role === "event") {
        const { eventType, eventData } = parsePersistedEvent(msg.toolResult);
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

  // The server's project list is the authority on whether a slug exists, so it is also what
  // lifts a delete tombstone. Clearing it at each creation call site instead would mean every
  // future path that creates a project has to remember to do so - and the ones that already
  // exist (plan handoff, executePlan) do not go through the create mutation at all.
  useEffect(() => {
    for (const project of projectsQuery.data ?? []) {
      deletedProjectsRef.current.delete(project.slug);
    }
  }, [projectsQuery.data]);

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

  // What a delete would actually remove. Fetched only while the dialog is open, so the
  // confirmation can name real numbers instead of asking the user to trust the word "alles".
  const deletionPreviewQuery = useQuery({
    queryKey: ["coding", "deletion-preview", projectToDelete],
    queryFn: () =>
      api.coding.deletionPreview(
        projectToDelete!,
        projectToDelete ? projectConversationMapRef.current[projectToDelete] : undefined
      ),
    enabled: Boolean(projectToDelete),
  });

  const deleteProject = useMutation({
    mutationFn: (project: string) =>
      api.coding.deleteProject(project, projectConversationMapRef.current[project]),
    onSuccess: async (result, project) => {
      // Everything that must happen BEFORE the first await, because the selection effect runs
      // on the very next render: while `selectedProject` still names the deleted project and
      // its mapping is gone, that effect would happily create a fresh conversation for a
      // project that no longer exists. Deselecting and marking it deleted in the same
      // synchronous block closes that window; the guard in ensureProjectConversation covers
      // the remainder.
      deletedProjectsRef.current.add(project);
      const known = projectConversationMapRef.current[project];
      if (known !== undefined) forgetProjectConversation(project, known);
      delete creatingConversationRef.current[project];

      const wasSelected = selectedProject === project;
      if (wasSelected) {
        // setSelectedProject clears open tabs and drafts on a real change; the chat has to be
        // cleared here, otherwise the deleted project's messages stay on screen under the
        // next project's name.
        setSelectedProject("");
        setConversationId(undefined);
        setMessages([]);
      }

      const remaining = (await qc.fetchQuery({
        queryKey: ["coding", "projects"],
        queryFn: () => api.coding.listProjects() as Promise<Array<{ slug: string; name: string }>>,
      })) as Array<{ slug: string }>;

      if (wasSelected) {
        setSelectedProject(remaining.find((entry) => entry.slug !== project)?.slug ?? "");
      }

      qc.removeQueries({ queryKey: ["coding", "files", project] });
      qc.removeQueries({ queryKey: ["coding", "checkpoints", project] });
      setProjectToDelete(null);
      toastManager.success(
        result.deletedConversationIds.length > 0
          ? `Projekt "${project}" und ${result.deletedConversationIds.length} zugehoerige(r) Chat(s) geloescht.`
          : `Projekt "${project}" geloescht.`
      );
    },
    onError: (error: unknown) => {
      toastManager.error(error instanceof Error ? error.message : "Loeschen fehlgeschlagen");
    },
  });

  const createProject = useMutation({
    mutationFn: (name: string) => api.coding.createProject(name),
    onSuccess: async (data: { created: boolean; slug: string; path: string }) => {
      setNewProjectName("");
      setShowCreateProjectModal(false);
      // Recreating a slug that was deleted earlier in this session makes it a live project
      // again - without lifting the tombstone it would be permanently unable to open a chat.
      deletedProjectsRef.current.delete(data.slug);

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
    let ensuredConversationId = projectConversationMapRef.current[selectedProject];

    try {
      if (ensuredConversationId) {
        try {
          await api.chat.getMessages(ensuredConversationId);
        } catch (error) {
          if (isConversationNotFoundError(error)) {
            forgetProjectConversation(selectedProject, ensuredConversationId);
            ensuredConversationId = undefined;
          } else {
            throw error;
          }
        }
      }

      if (!ensuredConversationId) {
        ensuredConversationId = await ensureProjectConversation(selectedProject);
      }

      setConversationId(ensuredConversationId);
    } catch {
      setIsEnsuringConversation(false);
      return;
    }

    const messageId = crypto.randomUUID();

    // Add user message to the chat store so it appears immediately.
    setMessages((prev) => [
      ...prev,
      {
        id: messageId,
        role: "user" as const,
        content: text,
        timestamp: new Date().toISOString(),
        metadata: { localMessageId: messageId },
      },
    ]);

    // Join the WebSocket room so live events (checklist, phases, assistant_text) arrive.
    const socket = useAppStore.getState().socket;
    if (socket) {
      socket.emit("chat:join", { conversationId: ensuredConversationId });
    }

    // Route through the CodingAgent HTTP endpoint — NOT the generic WebSocket agent. This
    // ensures the full CodingAgent discipline (phases, read-before-edit, diagnostics, verify
    // retry) applies to follow-up chat messages, just like the initial coding run.
    //
    // Fire-and-forget: the server emits chat:start → chat:event* → chat:complete through the
    // WebSocket channel we just joined, so isLoading and message rendering work automatically.
    void api.coding
      .runFollowUp(selectedProject, text, ensuredConversationId, {
        includeFile: options.includeFile,
        provider: chatProvider,
        model: chatModel,
      })
      .catch((error) => {
        console.error("[sendCodingPrompt] Follow-up failed:", error);
      });

    setIsEnsuringConversation(false);
  };

  // Robust plan execution: guarantees a coding project + conversation exist before
  // running, so "Execute" works even for a plan handed over from chat with nothing
  // selected yet. The project slug travels to the backend so files land in its sandbox.
  const executePlan = async (plan: Plan) => {
    let project = selectedProject;
    if (!project) {
      const name = uniqueProjectNameFrom(String(plan.goal || plan.title || "plan"));
      const created = await api.coding.createProject(name);
      project = created.slug;
      // The project selector's options come from this cached query - without refetching
      // it, selectedProject points at a slug the dropdown doesn't list yet.
      await qc.invalidateQueries({ queryKey: ["coding", "projects"] });
      setSelectedProject(project);
    }

    const convId = await ensureProjectConversation(project);
    setConversationId(convId);

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
          <button
            type="button"
            onClick={() => setProjectToDelete(selectedProject)}
            disabled={!selectedProject}
            title={t("codingPage.deleteProjectTitle")}
            aria-label={t("codingPage.deleteProjectTitle")}
            className="shrink-0 rounded-md border border-border p-1.5 text-muted-foreground transition hover:bg-accent hover:text-destructive disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>

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
          {previewType === "html" && (
            <button
              className={`rounded-md border border-border p-1.5 transition hover:bg-accent ${
                useRealPreview ? "border-primary/50 bg-primary/10 text-primary" : "text-muted-foreground"
              }`}
              onClick={() => {
                setUseRealPreview(true);
                setShowPreviewModal(true);
              }}
              title={t("codingPage.realPreview")}
            >
              <Globe className="h-3.5 w-3.5" />
            </button>
          )}
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
                  <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
                    <span>{t("codingPage.previewFile")}</span>
                    {previewType === "html" && useRealPreview && hasChanges && (
                      <span className="text-amber-500" title={t("codingPage.realPreviewStaleHint")}>
                        {t("codingPage.realPreviewStale")}
                      </span>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto bg-background/40">
                    {previewType === "html" && (
                      useRealPreview ? (
                        <iframe
                          key={`${selectedProject}/${selectedPath}`}
                          title="coding-html-preview"
                          src={api.coding.previewUrl(selectedProject!, selectedPath!)}
                          className="h-full w-full bg-white"
                        />
                      ) : (
                        <iframe title="coding-html-preview" srcDoc={editorContent} className="h-full w-full bg-white" />
                      )
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
              className="flex min-h-0 w-full min-w-0 shrink flex-col border-l border-border bg-card/40 md:shrink-0"
              style={{
                // On a phone the drag handle is hidden and the pixel width would overflow the
                // viewport, so the panel only takes its stored width from `md` upwards.
                ...(isNarrow
                  ? {}
                  : {
                      width: `${codingAgentWidth}px`,
                      minWidth: `${CODING_AGENT_MIN_WIDTH}px`,
                      maxWidth: `${CODING_AGENT_MAX_WIDTH}px`,
                    }),
              }}
            >
              <CodingAgentPanel
                messages={messages as RenderedChatMessage[]}
                isLoading={isLoading || isEnsuringConversation}
                streamingContent={streamingContent}
                conversationId={activeConversationId}
                project={selectedProject}
                activeFilePath={selectedPath}
                disabled={!selectedProject}
                overridePlan={handoffPlan}
                onExecutePlan={executePlan}
                onOpenFile={openFile}
                hasMoreMessages={conversationMessagesQuery.hasNextPage}
                isLoadingMoreMessages={conversationMessagesQuery.isFetchingNextPage}
                onLoadMoreMessages={() => void conversationMessagesQuery.fetchNextPage()}
                onSend={(text, options) => {
                  void sendCodingPrompt(text, options);
                }}
                onStop={stopMessage}
                onClearChat={
                  activeConversationId ? () => clearCodingMessages.mutate(activeConversationId) : undefined
                }
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

      {projectToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-lg font-semibold">{t("codingPage.deleteProjectTitle")}</h2>
              <button className="rounded p-1 hover:bg-accent" onClick={() => setProjectToDelete(null)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <p className="text-sm">
                {t("codingPage.deleteProjectQuestion")}{" "}
                <span className="font-mono font-semibold">{projectToDelete}</span>
              </p>

              {deletionPreviewQuery.isLoading && (
                <p className="text-xs text-muted-foreground">{t("codingPage.deleteProjectLoading")}</p>
              )}

              {deletionPreviewQuery.data && (
                <ul className="space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs">
                  <li>
                    {t("codingPage.deleteProjectFiles")}: <strong>{deletionPreviewQuery.data.fileCount}</strong>
                    {deletionPreviewQuery.data.totalBytes > 0 && (
                      <span className="text-muted-foreground">
                        {" "}
                        ({Math.max(1, Math.round(deletionPreviewQuery.data.totalBytes / 1024))} KB)
                      </span>
                    )}
                  </li>
                  <li>
                    {t("codingPage.deleteProjectChats")}:{" "}
                    <strong>{deletionPreviewQuery.data.conversations.length}</strong>
                    {deletionPreviewQuery.data.conversations.length > 0 && (
                      <span className="text-muted-foreground">
                        {" "}
                        (
                        {deletionPreviewQuery.data.conversations.reduce((sum, c) => sum + c.messageCount, 0)}{" "}
                        {t("codingPage.deleteProjectMessages")})
                      </span>
                    )}
                  </li>
                </ul>
              )}

              <p className="text-xs text-destructive">{t("codingPage.deleteProjectWarning")}</p>

              <div className="flex justify-end gap-2">
                <button className="btn-secondary" onClick={() => setProjectToDelete(null)}>
                  {t("common.cancel")}
                </button>
                <button
                  className="btn-primary bg-destructive hover:bg-destructive/90"
                  onClick={() => deleteProject.mutate(projectToDelete)}
                  disabled={deleteProject.isPending}
                >
                  <Trash2 className="mr-1 inline h-4 w-4" />
                  {t("codingPage.deleteProjectConfirm")}
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
              <div className="flex items-center gap-2">
                {previewType === "html" && (
                  <div className="flex overflow-hidden rounded-md border border-border text-[11px]">
                    <button
                      type="button"
                      onClick={() => setUseRealPreview(false)}
                      className={`px-2 py-1 transition ${!useRealPreview ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
                      title={t("codingPage.livePreview")}
                    >
                      {t("codingPage.livePreview")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setUseRealPreview(true)}
                      className={`px-2 py-1 transition ${useRealPreview ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
                      title={t("codingPage.realPreview")}
                    >
                      {t("codingPage.realPreview")}
                    </button>
                  </div>
                )}
                {previewType === "html" && useRealPreview && hasChanges && (
                  <span className="text-[11px] text-amber-500" title={t("codingPage.realPreviewStaleHint")}>
                    {t("codingPage.realPreviewStale")}
                  </span>
                )}
                <button className="rounded p-1 hover:bg-accent" onClick={() => setShowPreviewModal(false)}>
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden p-4">
              {previewType === "html" && (
                useRealPreview ? (
                  <iframe
                    key={`${selectedProject}/${selectedPath}`}
                    title="coding-html-preview-full"
                    src={api.coding.previewUrl(selectedProject!, selectedPath!)}
                    className="h-full w-full rounded-lg border border-border bg-white"
                  />
                ) : (
                  <iframe
                    title="coding-html-preview-full"
                    srcDoc={editorContent}
                    className="h-full w-full rounded-lg border border-border bg-white"
                  />
                )
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
