import { useState, useRef, useEffect } from "react";
import { Send, Trash2, Paperclip, Square, Image as ImageIcon, X, PanelLeft } from "lucide-react";
import { useAppStore, type ChatAttachment } from "../../lib/store";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { DuckyMascot } from "./DuckyMascot";
import { EventRow, MessageRow, StreamingRow } from "./ChatMessageRow";
import { ToolSkillSelector } from "./ToolSkillSelector";
import { PlanExecutionPanel, type Plan, type StepStatus } from "./PlanExecutionPanel";
import { BrowserPreviewModal } from "./BrowserPreview";
import type { AgentEventType, RenderedChatMessage } from "./chatTypes";

interface ConversationItem {
  id: number;
  name: string;
  projectId?: number;
  createdAt: string;
  updatedAt: string;
}

interface PersistedMessage {
  id: number;
  role: "user" | "assistant" | "system" | "tool" | "event";
  content: string;
  metadata?: string | null;
  toolCallId?: string | null;
  toolResult?: string | null;
  createdAt: string;
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

// Step titles are free text (LLM/user authored) - escape before dropping them into a RegExp.
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareMessages(a: RenderedChatMessage, b: RenderedChatMessage): number {
  const aTime = Date.parse(a.timestamp);
  const bTime = Date.parse(b.timestamp);
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
    return aTime - bTime;
  }

  if (a.id !== b.id) {
    return a.id.localeCompare(b.id);
  }

  return 0;
}

export function ChatContainer() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const {
    messages,
    sendMessage,
    stopMessage,
    clearChat,
    isLoading,
    streamingContent,
    conversationId,
    setConversationId,
    setMessages,
    connected,
    browserPreview,
    setBrowserPreviewModal,
  } = useAppStore();
  const [input, setInput] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [analyzeImages, setAnalyzeImages] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showConversationList, setShowConversationList] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [showSelector, setShowSelector] = useState(false);
  const [selectorQuery, setSelectorQuery] = useState("");
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const [showPlanPanel, setShowPlanPanel] = useState(false);
  const [currentPlan, setCurrentPlan] = useState<Plan | null | undefined>(null);
  const [lastProcessedPlanId, setLastProcessedPlanId] = useState<string>("");
  const [planExecuting, setPlanExecuting] = useState(false);
  const [executionProgress, setExecutionProgress] = useState<number | undefined>(0);
  const [executionStartMessageIndex, setExecutionStartMessageIndex] = useState(-1);
  const [stepStatuses, setStepStatuses] = useState<Record<number, StepStatus>>({});
  const [searchParams, setSearchParams] = useSearchParams();
  const [totalTokens, setTotalTokens] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const conversationsViewportRef = useRef<HTMLElement>(null);
  const pendingPrependHeightRef = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);
  const activeConversationRef = useRef<HTMLDivElement>(null);

  const defaultExpandedForType = (eventType?: AgentEventType) => false;

  useEffect(() => {
    const total = messages.reduce((sum, msg) => {
      const tokens = (msg.eventData?.totalTokens as number | undefined) ?? 0;
      return sum + tokens;
    }, 0);
    setTotalTokens(total);
  }, [messages]);

  useEffect(() => {
    if (activeConversationRef.current && conversationsViewportRef.current) {
      const viewport = conversationsViewportRef.current;
      const element = activeConversationRef.current;
      const elementTop = element.offsetTop;
      const elementHeight = element.clientHeight;
      const viewportHeight = viewport.clientHeight;
      const scrollTop = viewport.scrollTop;

      if (elementTop < scrollTop) {
        viewport.scrollTop = elementTop - 8;
      } else if (elementTop + elementHeight > scrollTop + viewportHeight) {
        viewport.scrollTop = elementTop + elementHeight - viewportHeight + 8;
      }
    }
  }, [conversationId]);

  const conversationsQuery = useInfiniteQuery({
    queryKey: ["chat", "conversations", "page"],
    queryFn: ({ pageParam }) =>
      api.chat.listConversationsPage({
        beforeId: pageParam as number | undefined,
        limit: 30,
      }) as Promise<{ items: ConversationItem[]; hasMore: boolean; nextBeforeId?: number }>,
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextBeforeId : undefined),
  });

  const selectedConversationMessages = useInfiniteQuery({
    queryKey: ["chat", "messages", conversationId],
    queryFn: ({ pageParam }) =>
      api.chat.getMessagesPage(conversationId ?? 0, {
        beforeId: pageParam as number | undefined,
        limit: 50,
      }) as Promise<{ items: PersistedMessage[]; hasMore: boolean; nextBeforeId?: number }>,
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextBeforeId : undefined),
    enabled: Boolean(conversationId),
  });

  const conversations = conversationsQuery.data?.pages.flatMap((page) => page.items) ?? [];

    const appliedQueryConversationId = useRef(false);
    useEffect(() => {
      // Only ever apply the ?conversationId= param once on initial load - otherwise this
      // effect re-fires on every render where the param is present and fights with manual
      // sidebar clicks / setConversationId calls made afterwards.
      if (appliedQueryConversationId.current) return;
      const fromQuery = Number(searchParams.get("conversationId") ?? "");
      if (Number.isFinite(fromQuery) && fromQuery > 0) {
        appliedQueryConversationId.current = true;
        setConversationId(fromQuery);
        const next = new URLSearchParams(searchParams);
        next.delete("conversationId");
        setSearchParams(next, { replace: true });
      }
    }, [searchParams, setConversationId, setSearchParams]);

    useEffect(() => {
      if (!conversationId) return;
      const persisted = selectedConversationMessages.data?.pages
        .slice()
        .reverse()
        .flatMap((page) => page.items);
      if (!persisted) return;

      // Only update messages from the query if we are not currently loading/streaming an active agent run.
      // This prevents stale results from overwriting local events and chunks received via WebSockets.
      if (!isLoading) {
        const mapPersistedMessage = (msg: PersistedMessage) => {
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
                  type === "mode_selected"
                ) {
                  eventType = type;
                }
                eventData = parsed.data;
              } catch {
                // Ignore malformed event metadata and render fallback event entry.
              }
            }

            return {
              id: `db-${msg.id}`,
              role: "event" as const,
              content: msg.content,
              timestamp: msg.createdAt,
              eventType,
              eventData,
              metadata,
            };
          }

          // Backward compatibility for old conversations saved before event persistence.
          if (msg.role === "assistant") {
            const raw = msg.content.trim();
            const isToolCall = raw.includes("[TOOL:") || raw.includes("<|tool_call>") || raw.includes("<tool_call>");
            if (isToolCall) {
              return {
                id: `db-${msg.id}`,
                role: "event" as const,
                content: raw,
                timestamp: msg.createdAt,
                eventType: "tool_call" as const,
                metadata,
              };
            }
          }

          if (msg.role === "tool") {
            let parsed: unknown;
            try {
              parsed = JSON.parse(msg.content);
            } catch {
              parsed = msg.content;
            }

            const success = Boolean((parsed as { success?: boolean })?.success);
            const error = (parsed as { error?: string })?.error;

            return {
              id: `db-${msg.id}`,
              role: "event" as const,
              content: success ? t("chat.toolSuccess") : `${t("chat.toolFailed")}${error ? `: ${error}` : ""}`,
              timestamp: msg.createdAt,
              eventType: "tool_result" as const,
              eventData: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : { raw: parsed },
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
        };

        const renderedPersisted = persisted.map(mapPersistedMessage);

        // Merge against the latest local (non-persisted) messages via the functional
        // updater so this effect does not depend on `messages` — depending on it while
        // also calling setMessages here caused an infinite render loop.
        setMessages((prev) => {
          const localMessages = prev.filter((m) => !m.id.startsWith("db-"));
          return [...renderedPersisted, ...localMessages].sort(compareMessages);
        });
      }
    }, [conversationId, selectedConversationMessages.data, setMessages, t, isLoading]);

  useEffect(() => {
    setExpandedEvents({});
  }, [conversationId]);

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;

    if (pendingPrependHeightRef.current !== null) {
      const previous = pendingPrependHeightRef.current;
      pendingPrependHeightRef.current = null;
      const delta = viewport.scrollHeight - previous;
      viewport.scrollTop = Math.max(0, viewport.scrollTop + delta);
      return;
    }

    if (stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streamingContent]);

  const handleMessagesScroll = () => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;

    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    stickToBottomRef.current = distanceToBottom < 120;

    if (viewport.scrollTop > 120) return;
    if (!selectedConversationMessages.hasNextPage || selectedConversationMessages.isFetchingNextPage) return;

    pendingPrependHeightRef.current = viewport.scrollHeight;
    void selectedConversationMessages.fetchNextPage();
  };

  const handleConversationsScroll = () => {
    const viewport = conversationsViewportRef.current;
    if (!viewport) return;
    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceToBottom > 120) return;
    if (!conversationsQuery.hasNextPage || conversationsQuery.isFetchingNextPage) return;
    void conversationsQuery.fetchNextPage();
  };

  const toBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result ?? "");
        const base64 = value.includes(",") ? (value.split(",")[1] ?? "") : value;
        resolve(base64);
      };
      reader.onerror = () => reject(new Error(t("chat.attachFile")));
      reader.readAsDataURL(file);
    });

  const handleSend = async () => {
    if ((!input.trim() && attachedFiles.length === 0) || isLoading || uploading) return;

    let uploadSummary = "";
    const attachments: ChatAttachment[] = [];
    if (attachedFiles.length > 0) {
      setUploading(true);
      try {
        for (const file of attachedFiles) {
          const contentBase64 = await toBase64(file);
          const uploaded = await api.shared.uploadFile({
            fileName: file.name,
            contentBase64,
            folder: "chat-uploads",
          });
          attachments.push({ name: file.name, path: uploaded.path, mimeType: file.type || undefined });
        }

        const imagePaths = attachments.filter((a) => a.mimeType?.startsWith("image/")).map((a) => a.path);
        const list = attachments.map((a) => `- shared-workspace/${a.path}`).join("\n");
        uploadSummary = `\n\n${t("chat.attachedFilesHeader")}\n${list}`;
        if (analyzeImages && imagePaths.length > 0) {
          uploadSummary += `\n\n${t("chat.pleaseAnalyzeImages")}\n${imagePaths
            .map((p) => `- shared-workspace/${p}`)
            .join("\n")}`;
        }
      } finally {
        setUploading(false);
      }
    }

    const finalInput = `${input.trim()}${uploadSummary}`.trim();
    if (!finalInput) return;

    sendMessage(finalInput, attachments.length > 0 ? attachments : undefined, planMode ? "plan" : undefined);
    setInput("");
    setAttachedFiles([]);
    setAnalyzeImages(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && showSelector) {
      setShowSelector(false);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // "/" triggers the tool/skill selector dropdown while the leading token (before the
  // first whitespace) is still being typed - mirrors how the agent itself only treats a
  // leading "/slug" as a skill request (extractRequestedSkillSlugs in agent.ts).
  const handleInputChange = (value: string) => {
    setInput(value);
    const trimmedStart = value.trimStart();
    if (trimmedStart.startsWith("/")) {
      const afterSlash = trimmedStart.slice(1);
      if (!/\s/.test(afterSlash)) {
        setSelectorQuery(afterSlash);
        setShowSelector(true);
        return;
      }
    }
    setShowSelector(false);
  };

  const handleInsertSkill = (slug: string) => {
    setInput(`/${slug} `);
    setShowSelector(false);
  };

  const handleToolExecuted = (result: { toolName: string; success: boolean; data: unknown; error?: string }) => {
    const summary = result.success
      ? `Tool "${result.toolName}" erfolgreich ausgefuehrt`
      : `Tool "${result.toolName}" fehlgeschlagen${result.error ? `: ${result.error}` : ""}`;
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "event",
        content: summary,
        timestamp: new Date().toISOString(),
        eventType: "tool_result",
        eventData: { toolName: result.toolName, success: result.success, data: result.data, error: result.error },
      },
    ]);
    setInput("");
    setShowSelector(false);
  };

  const handlePlanRefinement = async () => {
    if (!currentPlan) return;
    setShowPlanPanel(false);
    setInput(`Verbessere diesen Plan: ${currentPlan.goal}\n\nBisheriger Plan: ${currentPlan.markdown || JSON.stringify(currentPlan)}`);
  };

  const generateProjectNameFromGoal = (goal: string): string => {
    // Extract meaningful words from the goal
    const words = goal
      .toLowerCase()
      .replace(/[.,!?;:\(\)]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !["that", "with", "from", "create", "build"].includes(w))
      .slice(0, 3);

    if (words.length === 0) {
      return `project-${Date.now()}`;
    }

    return words.join("-").slice(0, 50);
  };

  const handlePlanExecution = async () => {
    if (!currentPlan) return;
    setPlanExecuting(true);
    setExecutionProgress(5);
    setExecutionStartMessageIndex(messages.length);
    setStepStatuses({}); // Reset step statuses

    try {
      // Create a project for this plan execution if it doesn't exist
      let projectId: number | undefined;
      try {
        const projectName = generateProjectNameFromGoal(currentPlan.goal || currentPlan.title || "project");
        const created = await api.projects.create({
          name: projectName,
          description: currentPlan.goal || currentPlan.title,
        });
        projectId = (created as any)?.id;
      } catch (projectError) {
        console.warn("Could not create project for plan execution:", projectError);
        // Continue execution without project - not critical
      }

      setExecutionProgress(15);

      // The plan lives in this session's event stream, not in a server-side store, so the
      // steps have to travel with the request - otherwise the agent would only receive an
      // id it cannot resolve back to any actual plan content.
      const result = await api.plans.execute(currentPlan.id, {
        goal: currentPlan.goal,
        steps: currentPlan.steps ?? [],
        markdown: currentPlan.markdown,
        conversationId: conversationId ?? undefined,
        projectId,
      });

      // Plan execution started - keep panel open for live updates from WebSocket
      // The agent runs asynchronously and sends updates via chat:event/chat:complete events
      // Don't close the panel or stop tracking - wait for actual completion message

      // Add a status message
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "event",
          content: `Plan-Ausführung gestartet (${currentPlan.steps?.length ?? 0} Schritte)`,
          timestamp: new Date().toISOString(),
          eventType: "iteration",
          eventData: { message: result?.message ?? "Plan execution started", planId: currentPlan.id },
        },
      ]);

      setExecutionProgress(10); // Keep panel visible
      // Don't close panel or stop tracking - wait for WebSocket completion events
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "event",
          content: `Umsetzung fehlgeschlagen: ${error instanceof Error ? error.message : "Unbekannter Fehler"}`,
          timestamp: new Date().toISOString(),
          eventType: "tool_result",
          eventData: { error: true },
        },
      ]);
      setPlanExecuting(false);
      setExecutionProgress(undefined);
    }
  };

  /** Opens the plan panel only for a finished plan-mode plan. Full mode also emits "plan"
   *  events for its internal auto-plan (source:"auto") - those are run-loop context and
   *  must not pop a modal over a run that is already executing. */
  const detectPlanFromMessages = (previousProcessedId: string) => {
    const lastPlanMessage = [...messages]
      .reverse()
      .find((msg) => msg.eventType === "plan" && (msg.eventData as { source?: string } | undefined)?.source === "plan_mode");

    if (lastPlanMessage?.id === previousProcessedId) return;
    if (!lastPlanMessage?.eventData) return;

    const planData = lastPlanMessage.eventData as unknown as Plan;
    if (planData.goal && Array.isArray(planData.steps) && planData.steps.length > 0) {
      setCurrentPlan(planData);
      setShowPlanPanel(true);
      setLastProcessedPlanId(lastPlanMessage.id);
      // A fresh plan starts clean - without this, a still-mounted stepStatuses/progress
      // from a previously executed plan would bleed into this one (steps re-indexed from
      // 0 can collide and show as falsely "Erledigt" before anything has run).
      setStepStatuses({});
      setExecutionProgress(0);
      setPlanExecuting(false);
    }
  };

  useEffect(() => {
    detectPlanFromMessages(lastProcessedPlanId);
  }, [messages, lastProcessedPlanId]);

  // Close plan panel and stop tracking when plan execution completes
  useEffect(() => {
    if (!planExecuting) return;

    // Check if the last message is a completion message
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) return;

    // If we see a completion-like message or if isLoading stopped, finish execution
    if (!isLoading && messages.length > executionStartMessageIndex) {
      // Give it a moment to ensure all events have arrived
      const timer = setTimeout(() => {
        if (!isLoading) {
          // Text-based step detection can miss the very last marker (e.g. the agent's
          // closing summary doesn't repeat "Schritt N") - finalize explicitly so the UI
          // never ends on a step still shown as "in Bearbeitung".
          setStepStatuses((prev) => {
            const stepCount = currentPlan?.steps?.length ?? 0;
            const finalized: Record<number, StepStatus> = { ...prev };
            for (let idx = 0; idx < stepCount; idx++) {
              if (finalized[idx] !== "failed") {
                finalized[idx] = "completed";
              }
            }
            return finalized;
          });
          setExecutionProgress(100);
          setPlanExecuting(false);
          // Keep panel open for 2 seconds to show completion, then close
          const closeTimer = setTimeout(() => {
            setShowPlanPanel(false);
          }, 2000);
          return () => clearTimeout(closeTimer);
        }
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [planExecuting, isLoading, messages, executionStartMessageIndex, currentPlan?.steps]);

  // Live progress + per-step status while a plan executes, combining two signals:
  //
  // 1. Tool usage (primary, deterministic): each plan step carries a "Benoetigte Tools"
  //    hint (currentPlan.steps[i].tools). Real tool_call/tool_result events emitted while
  //    the agent runs carry the actual tool name(s) invoked - matching those against each
  //    step's hint tells us which step is active without depending on the LLM narrating
  //    "Schritt N" in prose, which it often just doesn't do.
  // 2. Explicit "Schritt N" / step-title mentions in the agent's own streamed text
  //    (fallback for steps whose tool hint doesn't distinguish them from a neighbor).
  //
  // Both run over the live event/chunk stream (chat:event messages plus the in-flight
  // streamingContent), not just a settled message count, so the UI updates as things happen.
  useEffect(() => {
    if (!planExecuting || executionStartMessageIndex < 0 || !currentPlan?.steps) return;

    const steps = currentPlan.steps;
    const stepCount = steps.length;
    if (stepCount === 0) return;

    const executionMessages = messages.slice(executionStartMessageIndex);

    // --- Signal 1: tool usage vs. each step's declared tool hint ---
    const stepToolSets = steps.map((step) => new Set((step.tools ?? []).map((tool) => tool.toLowerCase())));
    let toolActiveStep = -1;
    const toolFailedSteps = new Set<number>();
    for (const msg of executionMessages) {
      if (msg.eventType !== "tool_call" && msg.eventType !== "tool_result") continue;
      const data = msg.eventData as { tools?: string[]; toolName?: string; success?: boolean } | undefined;
      const toolNames = (data?.tools ?? (data?.toolName ? [data.toolName] : [])).map((t) => t.toLowerCase());
      if (toolNames.length === 0) continue;

      const searchFrom = Math.max(toolActiveStep, 0);
      const matchIdx = stepToolSets.findIndex(
        (toolSet, idx) => idx >= searchFrom && toolNames.some((t) => toolSet.has(t))
      );
      if (matchIdx === -1) continue;

      toolActiveStep = matchIdx;
      if (msg.eventType === "tool_result") {
        if (data?.success === false) toolFailedSteps.add(matchIdx);
        else toolFailedSteps.delete(matchIdx);
      }
    }

    // --- Signal 2: explicit textual step markers (word-bounded to avoid false hits like
    // bullet numbers or version strings tripping a bare "1.") ---
    const liveText = [...executionMessages.map((m) => m.content), streamingContent].join("\n").toLowerCase();
    const completionWords = ["erledigt", "abgeschlossen", "done", "completed", "finished"];
    const failureWords = ["fehlgeschlagen", "gescheitert", "failed", "fehler"];
    const textMentionedSteps = new Set<number>();
    const textCompletedSteps = new Set<number>();
    const textFailedSteps = new Set<number>();

    steps.forEach((step, idx) => {
      const stepNum = idx + 1;
      const markerPattern = new RegExp(`\\bschritt\\s*${stepNum}\\b|\\bstep\\s*${stepNum}\\b`);
      const titlePattern = step.title ? new RegExp(`\\b${escapeForRegExp(step.title.toLowerCase())}\\b`) : null;
      if (!markerPattern.test(liveText) && !titlePattern?.test(liveText)) return;
      textMentionedSteps.add(idx);

      // Only look at the text between this step's own marker and the next one, so a later
      // step's "erledigt" doesn't retroactively mark an earlier, still-running step done.
      const nextMarkerPattern = new RegExp(`\\bschritt\\s*${stepNum + 1}\\b|\\bstep\\s*${stepNum + 1}\\b`);
      const afterMarker = liveText.split(markerPattern)[1] ?? liveText;
      const section = afterMarker.split(nextMarkerPattern)[0] ?? afterMarker;

      if (completionWords.some((w) => section.includes(w))) textCompletedSteps.add(idx);
      else if (failureWords.some((w) => section.includes(w))) textFailedSteps.add(idx);
    });
    const maxTextMentionedStep = Math.max(-1, ...Array.from(textMentionedSteps));

    // Neither signal fires for a single generic step (no tool hint, no "Schritt N" text) -
    // default to the first not-yet-signaled step so it reads as "in progress" instead of
    // sitting on "pending" for the whole run with no indication anything is happening.
    const signaledStep = Math.max(toolActiveStep, maxTextMentionedStep);
    const activeStep = signaledStep >= 0 ? signaledStep : 0;

    // --- Merge: whichever signal got further along wins for each step ---
    const newStatuses: Record<number, StepStatus> = {};
    for (let idx = 0; idx < stepCount; idx++) {
      const isDone = idx < activeStep || textCompletedSteps.has(idx);
      const isFailed = toolFailedSteps.has(idx) || textFailedSteps.has(idx);
      const isActive = idx === activeStep;

      if (isDone) {
        newStatuses[idx] = "completed";
      } else if (isFailed) {
        newStatuses[idx] = "failed";
      } else if (isActive) {
        newStatuses[idx] = "in_progress";
      } else {
        newStatuses[idx] = "pending";
      }
    }
    setStepStatuses(newStatuses);

    const completedCount = Object.values(newStatuses).filter((s) => s === "completed").length;
    const hasInProgress = Object.values(newStatuses).some((s) => s === "in_progress");
    // 10% for "started", the remaining 85% split across steps (half credit for the one
    // currently in progress so the bar keeps creeping forward between step markers).
    const stepFraction = (completedCount + (hasInProgress ? 0.5 : 0)) / stepCount;
    const progress = 10 + stepFraction * 85;
    setExecutionProgress(Math.round(isLoading ? Math.min(95, progress) : progress));
  }, [messages, streamingContent, planExecuting, currentPlan?.steps, executionStartMessageIndex, isLoading]);


  const deleteConversation = useMutation({
    mutationFn: (conversationIdToDelete: number) => api.chat.deleteConversation(conversationIdToDelete),
    onSuccess: async (_data, deletedId) => {
      if (conversationId === deletedId) {
        clearChat();
      }
      await qc.invalidateQueries({ queryKey: ["chat", "conversations", "page"] });
      await qc.invalidateQueries({ queryKey: ["chat", "messages", deletedId] });
    },
  });

  const clearMessages = useMutation({
    mutationFn: (conversationIdToClear: number) => api.chat.clearMessages(conversationIdToClear),
    onSuccess: async (_data, clearedId) => {
      clearChat();
      await qc.invalidateQueries({ queryKey: ["chat", "messages", clearedId] });
    },
  });

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <aside
        ref={conversationsViewportRef}
        onScroll={handleConversationsScroll}
        className={`${showConversationList ? "block" : "hidden"} lg:block ${compactMode ? "lg:w-72" : "lg:w-80"} w-full border-b lg:border-b-0 lg:border-r border-gray-800 p-3 overflow-y-auto space-y-2 max-h-[42vh] lg:max-h-none shrink-0`}
      >
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">{t("chat.chats")}</h2>
          <button
            onClick={() => {
              clearChat();
            }}
            className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700"
          >
            {t("chat.new")}
          </button>
        </div>

        {conversations.map((conv) => (
          <div
            key={conv.id}
            ref={conversationId === conv.id ? activeConversationRef : null}
            className={`w-full rounded-lg border px-3 py-2 transition ${
              conversationId === conv.id
                ? "border-blue-500 bg-blue-500/10"
                : "border-gray-800 bg-gray-900 hover:border-gray-700"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <button
                onClick={() => {
                  setConversationId(conv.id);
                }}
                className="min-w-0 text-left flex-1"
              >
                <div className="text-sm font-medium truncate">{conv.name}</div>
                <div className="text-xs text-gray-400 mt-1">
                  {new Date(conv.updatedAt).toLocaleString()}
                </div>
              </button>
              <button
                className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-red-300"
                onClick={() => {
                  const confirmed = window.confirm(`Chat '${conv.name}' loeschen?`);
                  if (!confirmed) return;
                  deleteConversation.mutate(conv.id);
                }}
                disabled={deleteConversation.isPending}
                title={t("common.delete")}
              >
                {t("common.delete")}
              </button>
            </div>
          </div>
        ))}

        {conversations.length === 0 && (
          <div className="text-xs text-gray-500 py-4">{t("chat.noSaved")}</div>
        )}
        {conversationsQuery.isFetchingNextPage && (
          <div className="text-xs text-gray-500 py-2">{t("chat.loadingMoreConversations")}</div>
        )}
      </aside>

      <div className="flex flex-col h-full min-h-0 flex-1 min-w-0">
      {/* Header */}
      <div className="p-4 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => setShowConversationList((prev) => !prev)}
            className="btn-secondary lg:hidden flex items-center gap-2"
          >
            <PanelLeft className="w-4 h-4" />
            {t("chat.chats")}
          </button>
          <h1 className="font-semibold truncate">Chat</h1>
          <DuckyMascot
            working={isLoading}
            connected={connected}
            size={28}
            title={isLoading ? t("chat.duckyWorkingTitle") : t("chat.duckyIdleTitle")}
          />
        </div>
        <div className="flex items-center gap-2">
          {totalTokens > 0 && (
            <div className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
              <span className="text-base">⚡</span>
              <span>{totalTokens.toLocaleString()}</span>
            </div>
          )}
          <button
            onClick={() => setPlanMode((prev) => !prev)}
            className={`text-sm px-3 py-1.5 rounded-lg border transition ${
              planMode
                ? "bg-indigo-500/20 border-indigo-500/40 text-indigo-200"
                : "bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600"
            }`}
            title="Plan-Modus: nur einen Plan erstellen, nichts ausfuehren"
          >
            {planMode ? "Plan (aktiv)" : "Plan"}
          </button>
          <button
            onClick={() => setCompactMode((prev) => !prev)}
            className="btn-secondary text-sm"
          >
            {compactMode ? t("chat.comfort") : t("chat.compact")}
          </button>
          {isLoading && (
            <button onClick={stopMessage} className="btn-secondary flex items-center gap-2 text-sm">
              <Square className="w-4 h-4" />
              Stop
            </button>
          )}
          <button
            onClick={() => {
              if (conversationId) {
                clearMessages.mutate(conversationId);
              } else {
                clearChat();
              }
            }}
            className="btn-secondary flex items-center gap-2 text-sm"
          >
            <Trash2 className="w-4 h-4" />
            {t("chat.clear")}
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={messagesViewportRef}
        onScroll={handleMessagesScroll}
        className={`flex-1 min-h-0 overflow-y-auto ${compactMode ? "px-2 py-2 sm:px-3" : "px-3 py-4 sm:px-4"}`}
      >
        <div className={`mx-auto w-full ${compactMode ? "max-w-3xl space-y-2" : "max-w-4xl space-y-4"}`}>
        {selectedConversationMessages.isFetchingNextPage && (
          <div className="text-center text-xs text-gray-500">{t("chat.loadingOlderMessages")}</div>
        )}
        {messages.length === 0 && (
          <div className="text-center text-gray-500 mt-20">
            <DuckyMascot working={false} connected={connected} size={56} className="mx-auto mb-4 opacity-80" />
            <p>{t("chat.startConversation")}</p>
          </div>
        )}

        {messages.map((msg) =>
          msg.role === "event" ? (
            <EventRow
              key={msg.id}
              msg={msg}
              t={t}
              expanded={expandedEvents[msg.id] ?? defaultExpandedForType(msg.eventType)}
              onToggle={(isOpen) => setExpandedEvents((prev) => ({ ...prev, [msg.id]: isOpen }))}
            />
          ) : (
            <MessageRow key={msg.id} msg={msg} compactMode={compactMode} t={t} />
          )
        )}

        {/* Streaming */}
        {isLoading && <StreamingRow compactMode={compactMode} streamingContent={streamingContent} t={t} />}

        <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className={`${compactMode ? "p-2 sm:p-3" : "p-3 sm:p-4"} border-t border-gray-800`}>
        <div className={`mx-auto w-full ${compactMode ? "max-w-3xl" : "max-w-4xl"}`}>
        {attachedFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {attachedFiles.map((file, idx) => (
              <span key={`${file.name}-${idx}`} className="inline-flex items-center gap-2 px-2 py-1 rounded bg-gray-800 text-xs text-gray-200 border border-gray-700">
                {file.name}
                <button
                  onClick={() => setAttachedFiles((prev) => prev.filter((_, i) => i !== idx))}
                  className="text-gray-400 hover:text-white"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            <button
              onClick={() => setAnalyzeImages((v) => !v)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ${analyzeImages ? "bg-blue-500/20 border-blue-500/40 text-blue-200" : "bg-gray-800 border-gray-700 text-gray-300"}`}
            >
              <ImageIcon className="w-3 h-3" />
              {analyzeImages ? t("chat.imageAnalysisOn") : t("chat.imageAnalysisOff")}
            </button>
          </div>
        )}

        <div className="relative flex gap-2">
          {showSelector && (
            <ToolSkillSelector
              query={selectorQuery}
              conversationId={conversationId}
              onInsertSkill={handleInsertSkill}
              onToolExecuted={handleToolExecuted}
              onClose={() => setShowSelector(false)}
            />
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) setAttachedFiles((prev) => [...prev, ...files]);
              e.currentTarget.value = "";
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="btn-secondary flex items-center gap-2"
            title={t("chat.attachFile")}
          >
            <Paperclip className="w-4 h-4" />
          </button>

          <textarea
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("chat.inputPlaceholder")}
            rows={1}
            className={`input flex-1 resize-none min-h-[40px] ${compactMode ? "max-h-24 sm:max-h-32" : "max-h-28 sm:max-h-40"}`}
            style={{ height: "auto" }}
          />
          <button
            onClick={handleSend}
            disabled={(!input.trim() && attachedFiles.length === 0) || isLoading || uploading}
            className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
        </div>
      </div>
      </div>

      {/* Plan Execution Panel */}
      {showPlanPanel && currentPlan && currentPlan.goal && currentPlan.steps && (
        <PlanExecutionPanel
          plan={currentPlan as Plan}
          onRefine={handlePlanRefinement}
          onExecute={handlePlanExecution}
          onClose={() => setShowPlanPanel(false)}
          isExecuting={planExecuting}
          executionProgress={executionProgress}
          stepStatuses={stepStatuses}
        />
      )}

      {/* Browser Preview Modal */}
      {browserPreview.showModal && browserPreview.currentPreview && (
        <BrowserPreviewModal
          data={browserPreview.currentPreview}
          onClose={() => setBrowserPreviewModal(false)}
        />
      )}
    </div>
  );
}
