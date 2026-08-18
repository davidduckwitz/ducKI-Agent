import { useState, useRef, useEffect, useMemo } from "react";
import { ArrowDown, Plus, Trash2, X } from "lucide-react";
import { useAppStore, type ChatAttachment, registerChatCompleteCallback } from "../../lib/store";
import { useUiStore } from "../../lib/uiStore";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { DynamicCharacter } from "./characters/DynamicCharacter";
import { ToolResponseDock } from "./ToolResponseCard";
import { BrowserSessionManager } from "./BrowserSessionManager";
import { EventRow, MessageRow, StreamingRow } from "./ChatMessageRow";
import { ToolGroupRow } from "./ToolGroupRow";
import { ChatHeader } from "./ChatHeader";
import { ChatComposer } from "./ChatComposer";
import { ChatWelcome } from "./ChatWelcome";
import { type Plan, type StepStatus } from "./PlanExecutionPanel";
import { BrowserPreviewModal } from "./BrowserPreview";
import { ToolEventsDisplay } from "./ToolEventsDisplay";
import { ToolEventSummary } from "./ToolEventSummary";
import { IterationMetrics } from "./IterationMetrics";
import type { AgentEventType, RenderedChatMessage } from "./chatTypes";
import {
  buildEventDedupKey,
  buildPersistedIndex,
  compareMessages,
  isSupersededByPersisted,
  normalizeMessageForDedup,
} from "./messageOrder";

interface ToolSummaryItem {
  id: string;
  events: Array<{
    type: "tool-start" | "tool-progress" | "tool-complete" | "tool-error" | "tool-warning";
    toolName: string;
    timestamp: Date;
    data?: Record<string, unknown>;
  }>;
}

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

export function ChatContainer() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const {
    messages,
    sendMessage,
    stopMessage,
    clearChat,
    handleNewChat,
    isLoading,
    streamingContent,
    conversationId,
    awaitingNewConversation,
    setConversationId,
    setMessages,
    connected,
    browserPreview,
    setBrowserPreviewModal,
    toolCalls,
    removeToolCall,
    showToolDock,
    selectedCharacterId,
    characterCustomizations,
    animationStyle,
    socket,
    chatProvider,
    chatModel,
  } = useAppStore();
  const [input, setInput] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [analyzeImages, setAnalyzeImages] = useState(false);
  const [uploading, setUploading] = useState(false);
  // The sidebar now carries the recent + pinned chats, so this column starts folded
  // away on every breakpoint. It stays available for search / infinite scroll / delete.
  const { chatListOpen, toggleChatList } = useUiStore();
  const navigate = useNavigate();
  const [compactMode, setCompactMode] = useState(false);
  // Plan mode kind: "cowork" = general task plan (stays in chat, default), "code" = coding
  // plan that hands off to the Coding Area, null = plan mode off. Default is "cowork" so the
  // agent plans general tasks in chat instead of always producing a coding plan.
  const [planKind, setPlanKind] = useState<"code" | "cowork" | null>(null);
  const planMode = planKind !== null;
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const [expandedToolGroups, setExpandedToolGroups] = useState<Record<string, boolean>>({});
  const [showPlanPanel, setShowPlanPanel] = useState(false);
  const [currentPlan, setCurrentPlan] = useState<Plan | null | undefined>(null);
  const [lastProcessedPlanId, setLastProcessedPlanId] = useState<string>("");
  const [planExecuting, setPlanExecuting] = useState(false);
  const [executionProgress, setExecutionProgress] = useState<number | undefined>(0);
  const [stepStatuses, setStepStatuses] = useState<Record<number, StepStatus>>({});
  const [searchParams, setSearchParams] = useSearchParams();
  const [totalTokens, setTotalTokens] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [toolSummaries, setToolSummaries] = useState<ToolSummaryItem[]>([]);
  const [persistentStreamingContent, setPersistentStreamingContent] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const conversationsViewportRef = useRef<HTMLElement>(null);
  const pendingPrependHeightRef = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);
  const activeConversationRef = useRef<HTMLDivElement>(null);
  const conversationListSyncRef = useRef<number | undefined>(conversationId);
  const mergePreviousConversationRef = useRef<number | undefined>(conversationId);
  const lastProcessedDataSnapshotRef = useRef<string>("");

  const defaultExpandedForType = (eventType?: AgentEventType) => false;

  // Fold a CONTIGUOUS run of tool_call/tool_result/tool_retry events into a single collapsible
  // group, so a turn firing several tools doesn't leave a wall of separate boxes in the timeline.
  // When the server supplies a toolBatchId (all tools of one LLM turn), a change of batch splits the
  // group; otherwise adjacency alone groups them (any non-tool event in between ends the run). The
  // group id is derived from the first event's stable dedup key so its open/closed state survives the
  // local→persisted id swap instead of resetting mid-run.
  const renderItems = useMemo(() => {
    const TOOL_GROUP_TYPES = new Set(["tool_call", "tool_result", "tool_retry"]);
    type RenderItem =
      | { kind: "message"; msg: RenderedChatMessage }
      | { kind: "toolGroup"; id: string; events: RenderedChatMessage[] };

    type ToolGroup = { id: string; batchId?: string; events: RenderedChatMessage[] };

    const items: RenderItem[] = [];
    let currentGroup: ToolGroup | null = null;

    // The same toolBatchId can legitimately produce more than one group (a non-batch event splitting a
    // run, or the live→persisted merge briefly holding both copies), which would emit two React children
    // with the same key. Suffix any repeat of a base id so keys stay unique; the first occurrence keeps
    // the stable base id, so open/closed state is preserved for the common (non-colliding) case.
    const idCounts = new Map<string, number>();
    const flushGroup = () => {
      if (currentGroup && currentGroup.events.length > 0) {
        const base = currentGroup.id;
        const seen = (idCounts.get(base) ?? 0) + 1;
        idCounts.set(base, seen);
        const uniqueId = seen === 1 ? base : `${base}#${seen}`;
        items.push({ kind: "toolGroup", id: uniqueId, events: currentGroup.events });
      }
      currentGroup = null;
    };

    const makeGroup = (msg: RenderedChatMessage, batchId: string | undefined): ToolGroup => ({
      id: batchId
        ? `group-${batchId}`
        : `group-${buildEventDedupKey(msg.eventType, msg.content, msg.timestamp)}`,
      ...(batchId ? { batchId } : {}),
      events: [msg],
    });

    for (const msg of messages) {
      const isToolEvent =
        msg.role === "event" && !!msg.eventType && TOOL_GROUP_TYPES.has(msg.eventType);

      if (isToolEvent) {
        const batchId = msg.eventData?.["toolBatchId"] as string | undefined;
        if (!currentGroup) {
          currentGroup = makeGroup(msg, batchId);
        } else if (batchId && currentGroup.batchId && batchId !== currentGroup.batchId) {
          // Explicit batch boundary within a contiguous run: start a fresh group.
          flushGroup();
          currentGroup = makeGroup(msg, batchId);
        } else {
          currentGroup.events.push(msg);
        }
        continue;
      }

      // A non-tool event that belongs to the active batch (e.g. a browser_preview screenshot emitted
      // BETWEEN the tool_call and its tool_result) must not close the group - otherwise the tool_call
      // ends up alone in a box that can never leave the "running" state. Render it inline but keep the
      // group open so the batch's tool_result events rejoin the same collapsible box.
      const msgBatchId = msg.eventData?.["toolBatchId"] as string | undefined;
      if (currentGroup && msgBatchId && currentGroup.batchId === msgBatchId) {
        items.push({ kind: "message", msg });
        continue;
      }

      flushGroup();
      items.push({ kind: "message", msg });
    }
    flushGroup();

    return items;
  }, [messages]);

  // Track streaming content so it persists even after streamingContent is cleared
  // Keep it visible during streaming, then clear once the actual message appears in the chat
  useEffect(() => {
    if (streamingContent.trim().length > 0) {
      setPersistentStreamingContent(streamingContent);
    }
  }, [streamingContent]);

  // Auto-clear the streaming box once the run is over, so it hands off to the real assistant
  // message instead of lingering.
  //
  // This used to wait for `messages[last].role === "assistant"`, which is a condition that
  // mostly never becomes true: the agent persists its assistant message BEFORE running the
  // turn's tools, so that row's timestamp sits early in the run while every tool_result and
  // reasoning event that follows is stamped later. Once the persisted history is merged in and
  // sorted, the last row is an event, not the assistant message - the box was never cleared and
  // the next turn re-displayed the previous answer (the render condition below also fires on
  // plain `isLoading`). Keying off "the run ended" instead holds regardless of what sorts last.
  useEffect(() => {
    if (persistentStreamingContent.trim().length === 0) return;
    if (isLoading) return;

    // Brief delay so the box does not blink out before the real message paints.
    const timer = setTimeout(() => {
      setPersistentStreamingContent("");
    }, 300);
    return () => clearTimeout(timer);
  }, [isLoading, persistentStreamingContent]);

  // Belt and braces: a new turn must never inherit the previous turn's streamed text, even if
  // the clear above was somehow skipped (an error path, a reconnect, a run that ended without
  // ever going idle). Fires only on the idle -> running edge, so it cannot wipe mid-stream.
  const wasLoadingRef = useRef(false);
  useEffect(() => {
    if (isLoading && !wasLoadingRef.current) {
      setPersistentStreamingContent("");
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading]);

  // Clear persistent content when conversation changes (user starts new chat)
  useEffect(() => {
    setPersistentStreamingContent("");
  }, [conversationId]);

  useEffect(() => {
    const total = messages.reduce((sum, msg) => {
      const tokens = (msg.eventData?.totalTokens as number | undefined) ?? 0;
      return sum + tokens;
    }, 0);
    setTotalTokens(total);
  }, [messages]);

  useEffect(() => {
    if (!isLoading) return;
    if (streamingContent.trim().length > 0) return;

    let lastUserIndex = -1;
    let lastAssistantIndex = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.role === "user") lastUserIndex = i;
      if (messages[i]?.role === "assistant") lastAssistantIndex = i;
    }

    // Defensive fallback: if an assistant reply is already present after the latest user
    // message but loading is still true, a completion event was likely missed.
    if (lastAssistantIndex > lastUserIndex && lastAssistantIndex >= 0) {
      useAppStore.setState({ isLoading: false, streamingContent: "" });
    }
  }, [messages, isLoading, streamingContent]);

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
        limit: 25,
      }) as Promise<{ items: PersistedMessage[]; hasMore: boolean; nextBeforeId?: number }>,
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextBeforeId : undefined),
    enabled: Boolean(conversationId),
    staleTime: 1000 * 60 * 5,  // 5 minutes - prevent aggressive refetch
    gcTime: 0,                 // No cache - delete immediately to prevent carry-over
  });

  // Fetched directly by id (not derived from the paginated sidebar list) so a conversation
  // created by the plugin wizard still resolves its pluginContext even once it has scrolled
  // off the currently-loaded page. Drives the [CODING_CONTEXT] marker in handleSend below.
  const activeConversationQuery = useQuery({
    queryKey: ["chat", "conversation", conversationId],
    queryFn: () => api.chat.getConversation(conversationId!),
    enabled: Boolean(conversationId),
    staleTime: 1000 * 60 * 5,
  });
  const pluginContext = activeConversationQuery.data?.pluginContext ?? undefined;

  const conversations = conversationsQuery.data?.pages.flatMap((page) => page.items) ?? [];

  useEffect(() => {
    // A brand-new chat only gets its conversationId once the server creates it in response
    // to the first message (see chat:conversation in store.ts) - the sidebar's cached list
    // has no way to know about it yet. Refetch exactly on that undefined -> defined
    // transition so the newly named conversation shows up without waiting on staleTime.
    const previous = conversationListSyncRef.current;
    conversationListSyncRef.current = conversationId;
    if (previous === undefined && conversationId !== undefined) {
      void qc.invalidateQueries({ queryKey: ["chat", "conversations", "page"] });
    }
  }, [conversationId, qc]);

  // Register callback to add completed messages directly to React Query cache
  // This avoids race conditions where chat:complete is called before DB persistence
  useEffect(() => {
    registerChatCompleteCallback((convId: number, response: string, messageId: string) => {
      // Don't wait for DB - add to cache immediately so it appears in UI right away
      // The Store already added it, so we just need to ensure React Query also has it
      // Only update if React Query has already fetched this conversation's messages
      const existing = qc.getQueryData(["chat", "messages", convId]);
      if (!existing) {
        console.log("[cache update] Skipping - React Query cache not initialized yet");
        return; // React Query hasn't fetched yet, don't create empty cache
      }

      qc.setQueryData(
        ["chat", "messages", convId],
        (old: any) => {
          if (!old || !old.pages) return old;
          // Add the new message to the first page
          return {
            ...old,
            pages: old.pages.map((page: any, idx: number) =>
              idx === 0 ? {
                ...page,
                items: [
                  ...page.items,
                  {
                    id: Math.max(...page.items.map((m: any) => m.id || 0), 0) + 1,
                    role: "assistant",
                    content: response,
                    createdAt: new Date().toISOString(),
                    metadata: JSON.stringify({ serverMessageId: messageId }),
                  }
                ]
              } : page
            )
          };
        }
      );
    });
  }, [qc]);

  // Reconnect safety net: if a run finished while the socket was disconnected, its
  // chat:complete was emitted to the conversation room with nobody listening, so the store
  // never received it. On (re)connect, refetch the active conversation's persisted messages
  // so the completed answer appears without a manual page reload. The initial connect is
  // harmless (query is refetched or still disabled when no conversation is open).
  useEffect(() => {
    if (!socket) return;
    const handleReconnect = () => {
      if (typeof conversationId === "number") {
        void qc.invalidateQueries({ queryKey: ["chat", "messages", conversationId] });
      }
    };
    socket.on("connect", handleReconnect);
    return () => {
      socket.off("connect", handleReconnect);
    };
  }, [socket, conversationId, qc]);

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

      // Detect chat switch - clear old messages before processing new ones
      const previousId = mergePreviousConversationRef.current;
      if (previousId !== undefined && conversationId !== previousId) {
        setMessages([]);
        setExpandedEvents({});

        // CRITICAL FIX #1: REMOVE the old query completely - don't just set data to undefined
        // setQueryData() leaves cached data; removeQueries() deletes the entire cache entry
        // This prevents stale data from being used when the new query hasn't loaded yet
        qc.removeQueries({
          queryKey: ["chat", "messages", previousId],
        });

        // Reset snapshot so new chat's data is processed
        lastProcessedDataSnapshotRef.current = "";
      }

      // CRITICAL FIX #2: Update ref AFTER all checks, not before
      // This ensures previousId stays accurate for the duration of this effect
      mergePreviousConversationRef.current = conversationId;

      // CRITICAL FIX #3: Stricter guards to prevent merge before new query has data

      // When conversationId transitions from undefined → defined (new chat),
      // wait until the query has actually loaded before merging
      const isNewConversation = previousId === undefined && conversationId !== undefined;
      if (isNewConversation && (selectedConversationMessages.isLoading || !selectedConversationMessages.data)) {
        // New chat's query not yet loaded - skip merge for now
        return;
      }

      // Skip all merging if still waiting for new conversation to be created
      // Don't merge ANY data while creating a new chat - prevents old messages from bleeding through
      if (awaitingNewConversation) {
        return;
      }

      // When switching between existing chats, wait for new query to load
      // Check: did conversationId change from one real value to another?
      const isChatSwitch = previousId !== undefined && conversationId !== previousId;
      if (isChatSwitch && (selectedConversationMessages.isLoading || !selectedConversationMessages.data)) {
        // New chat's query still loading - skip merge
        return;
      }

      // Skip merge if currently refetching - prevents overwriting Store messages with stale data
      // Only proceed if data is loaded AND not currently fetching fresh data
      if (selectedConversationMessages.isFetching && !isChatSwitch && !isNewConversation) {
        return;
      }

      const persisted = selectedConversationMessages.data?.pages
        .slice()
        .reverse()
        .flatMap((page) => page.items);
      if (!persisted) return;

      // IDEMPOTENCY: Only process if the data has actually changed since last run
      // Include conversationId in snapshot so switching chats always re-merges
      // Use string length comparison as a lightweight snapshot - full JSON.stringify
      // would be more accurate but expensive for large message sets
      const dataSnapshot = `${conversationId}:${persisted.length}:${persisted.map((p) => p.id).join(",")}`;
      if (dataSnapshot === lastProcessedDataSnapshotRef.current) {
        return;  // Already processed this exact data, skip
      }
      lastProcessedDataSnapshotRef.current = dataSnapshot;

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
                type === "checklist" ||
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
                type === "internal_instruction" ||
                type === "assistant_text"
              ) {
                eventType = type;
              }
              eventData = parsed.data;
            } catch {
              // Ignore malformed event metadata and render fallback event entry.
            }
          }

          // A block of the agent's own text. Stored as an "event" row only so it stays out of
          // the LLM context on reload - to the reader it is simply the agent talking, at the
          // point in the run where it said it.
          if (eventType === "assistant_text") {
            return {
              id: `db-${msg.id}`,
              role: "assistant" as const,
              content: msg.content,
              timestamp: msg.createdAt,
              metadata: {
                ...metadata,
                ...(eventData?.["displayMessageId"]
                  ? { displayMessageId: eventData["displayMessageId"] }
                  : {}),
              },
            };
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

      const renderedPersisted = persisted
        .map(mapPersistedMessage)
        // Synthetic follow-up prompts (metadata.internal) are only there to steer the LLM;
        // their user-facing status note was already shown live as an internal_instruction
        // event, so the raw prompt itself must not also render as a fake user turn.
        .filter((m) => !(m.role === "user" && m.metadata?.internal === true))
        // Raw model turns (markers and all) exist purely so the LLM sees what issued the tool
        // calls. Their readable counterpart is the assistant_text row written alongside them.
        // Only rows explicitly flagged are dropped, so conversations recorded before display
        // rows existed keep rendering exactly as they did.
        .filter((m) => m.metadata?.llmOnly !== true);

      // Merge against the latest local (non-persisted) messages via the functional
      // updater so this effect does not depend on `messages` — depending on it while
      // also calling setMessages here caused an infinite render loop.
      setMessages((prev) => {
        // Always preserve local (non-persisted) messages until they appear in DB.
        // During streaming: shows live updates while agent runs
        // After agent completes: shows messages until DB catches up
        // The query will eventually fetch them from DB and deduplicate here
        const localMessages = prev.filter((m) => !m.id.startsWith("db-"));

        // Index the RENDERED history, not the raw rows - mapPersistedMessage can change a row's
        // role, and dedup has to go by what the timeline actually shows. Then drop the local
        // copies of anything already represented there.
        const persistedIndex = buildPersistedIndex(renderedPersisted);
        let uniqueLocalMessages = localMessages.filter((m) => !isSupersededByPersisted(m, persistedIndex));

        // Fallback dedupe for first-message race: optimistic local user/assistant entries
        // can still survive if the persisted counterpart has no localMessageId link.
        // Match by role+content with a tight time window to avoid removing older repeats.
        const persistedByContent = new Map<string, number[]>();
        for (const p of renderedPersisted) {
          if (p.role === "event") continue;
          const key = `${p.role}:${normalizeMessageForDedup(p.content)}`;
          const list = persistedByContent.get(key) ?? [];
          const ts = Date.parse(p.timestamp);
          if (Number.isFinite(ts)) list.push(ts);
          persistedByContent.set(key, list);
        }

        uniqueLocalMessages = uniqueLocalMessages.filter((m) => {
          if (m.role === "event") return true;
          const key = `${m.role}:${normalizeMessageForDedup(m.content)}`;
          const persistedTimes = persistedByContent.get(key);
          if (!persistedTimes || persistedTimes.length === 0) return true;

          const localTime = Date.parse(m.timestamp);
          if (!Number.isFinite(localTime)) return true;

          return !persistedTimes.some((persistedTime) => Math.abs(persistedTime - localTime) <= 15_000);
        });

        return [...renderedPersisted, ...uniqueLocalMessages].sort(compareMessages);
      });
    }, [
      conversationId,
      awaitingNewConversation,
      selectedConversationMessages.data,
      selectedConversationMessages.isFetching,
      // isLoading omitted: isLoading is checked in guards but causes duplicate runs
      // isFetching is needed so effect runs when refetch completes, but guard skips during active fetch
    ]);

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

    // Always scroll to bottom when new messages arrive OR user is near bottom
    // Check if user is within 500px of bottom (very generous)
    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const shouldAutoScroll = stickToBottomRef.current || distanceToBottom < 500;

    if (shouldAutoScroll) {
      // Use setTimeout to ensure DOM has updated before scrolling
      setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 0);
    }
  }, [messages, streamingContent, persistentStreamingContent]);

  const handleMessagesScroll = () => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;

    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    // Stick to bottom if within 300px (generous threshold for auto-scroll)
    stickToBottomRef.current = distanceToBottom < 300;
    setShowScrollDown(distanceToBottom > 400);

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
    // Check current state - these need to be checked from the ref to get latest values
    if (!conversationsQuery.hasNextPage) return;
    if (conversationsQuery.isFetchingNextPage) return;
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

    // Conversation was created by the plugin wizard (packages/agent CodingAgent): wrap the
    // prompt in the same [CODING_CONTEXT] marker CodingWorkspace.tsx uses, so the server (see
    // agent.ts's isCodingContextRun check + websocket/index.ts's sandbox resolution) treats this
    // as a coding run with a proper iteration budget and scopes the filesystem tool to the
    // plugin's own folder instead of misclassifying a short follow-up as "lightweight".
    const contentToSend = pluginContext
      ? [
          "[CODING_CONTEXT]",
          `project=${pluginContext}`,
          "Your working directory IS this plugin's folder (plugins/" + pluginContext + "/). Use file paths RELATIVE to it,",
          "e.g. \"plugin.json\" or \"tools/foo.tool.json\". Do NOT prefix paths with the plugin name, \"plugins/\", or an absolute path.",
          "",
          finalInput,
        ].join("\n")
      : finalInput;

    void sendMessage(
      contentToSend,
      attachments.length > 0 ? attachments : undefined,
      planMode ? "plan" : undefined,
      pluginContext ? finalInput : undefined,
      chatProvider,
      chatModel
    );
    setInput("");
    setAttachedFiles([]);
    setAnalyzeImages(false);
  };

  const handleInsertSkill = (slug: string) => {
    setInput(`/${slug} `);
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
  };

  const handlePlanRefinement = async () => {
    if (!currentPlan) return;
    setShowPlanPanel(false);
    setInput(`Verbessere diesen Plan: ${currentPlan.goal}\n\nBisheriger Plan: ${currentPlan.markdown || JSON.stringify(currentPlan)}`);
  };

  // Once a plan has actually been executed, "Verbessern" shouldn't just tweak the old plan
  // description - the real project files now exist, so it should send the agent off to
  // inspect what's actually there and ask what to change, then send it immediately (no
  // prefilled text to review) since the whole point is a fast analyze-and-ask round trip.
  const handlePlanImprovementAnalysis = async () => {
    if (!currentPlan) return;
    setShowPlanPanel(false);
    const linkedProjectId = conversations.find((c) => c.id === conversationId)?.projectId;

    // Left to guess, the agent has no reliable way to derive the real absolute folder from a
    // project id/name alone (it doesn't know the shared-workspace/coding/<slug> convention,
    // and the actual content is often one level deeper in a sub-folder it created itself) -
    // it previously latched onto a plausible-looking but wrong path and got "Directory not
    // found". Since execution already persists the resolved folder onto the project (see
    // plans.ts), fetch and hand over that exact path instead of leaving it to chance.
    let projectFolderHint =
      "Analysiere die tatsächlich vorhandenen Dateien und den aktuellen Stand des Projekts (nutze deine Tools, z.B. filesystem/git).";
    if (linkedProjectId) {
      try {
        const project = (await api.projects.get(linkedProjectId)) as { name?: string; folder?: string } | null;
        // project.folder is only populated once this project has been executed at least
        // once since the folder-persisting fix shipped (older projects predate it) - for
        // those, fall back to the same slug rule the server itself uses to resolve a
        // project's sandbox (name.toLowerCase().replace(/\s+/g, "-")), which is a
        // deterministic derivation, not a guess.
        const resolvedFolder =
          project?.folder ||
          (project?.name ? `shared-workspace/coding/${project.name.toLowerCase().replace(/\s+/g, "-")}` : undefined);
        projectFolderHint = resolvedFolder
          ? [
              `Das Projekt liegt in folgendem Ordner (relativ zum Arbeitsverzeichnis des Servers, falls kein absoluter Pfad): ${resolvedFolder}`,
              "Nutze GENAU diesen Pfad als basePath für deine filesystem/git-Tool-Aufrufe - rate den Pfad nicht selbst und verwende keinen anderen Ordner.",
              "Liste zuerst den Inhalt dieses Ordners auf (die eigentlichen Dateien können in einem Unterordner liegen), bevor du einzelne Dateien liest.",
            ].join("\n")
          : `Das zugehörige Projekt hat die ID ${linkedProjectId}. Ermittle darüber (z.B. per project-Tool) den echten Projektordner, bevor du filesystem/git-Tools darauf anwendest.`;
      } catch {
        // Fall back to the generic instruction above if the project lookup fails.
      }
    }

    const prompt = [
      `Der folgende Plan wurde bereits umgesetzt: "${currentPlan.goal}"`,
      currentPlan.markdown ? `Ursprünglicher Plan:\n${currentPlan.markdown}` : "",
      projectFolderHint,
      "Stelle mir anschließend gezielte Rückfragen dazu, was am bisherigen Ergebnis verbessert, korrigiert oder ergänzt werden soll, bevor du einen neuen, verbesserten Plan erstellst.",
      "Führe noch keine Änderungen aus - erst Analyse und Rückfragen.",
    ]
      .filter(Boolean)
      .join("\n\n");

    void sendMessage(prompt, undefined, undefined, "Plan verbessern: Dateien analysieren und Rückfragen stellen");
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
    setStepStatuses({}); // Reset step statuses

    try {
      // Reuse the project already linked to this conversation (e.g. from a previous
      // execution of this same plan/thread) instead of spinning up a disconnected new one
      // each time - an "improve this plan" round must land in the same project folder.
      let projectId: number | undefined = conversations.find((c) => c.id === conversationId)?.projectId;
      let sandboxRoot: string | undefined;

      if (!projectId) {
        try {
          const projectName = generateProjectNameFromGoal(currentPlan.goal || currentPlan.title || "project");
          const created = await api.projects.create({
            name: projectName,
            description: currentPlan.goal || currentPlan.title,
          });
          projectId = (created as any)?.id;
          // Derive slug from project name: lowercase + replace spaces with hyphens
          // Frontend sends only the project slug to server, server combines it with CODING_ROOT
          sandboxRoot = projectName.toLowerCase().replace(/\s+/g, "-");
        } catch (projectError) {
          console.warn("Could not create project for plan execution:", projectError);
          // Continue execution without project - not critical
        }
      } else {
        // If project already exists, derive slug from its name
        try {
          const existingProject = await api.projects.get(projectId);
          const projectName = (existingProject as any)?.name;
          if (projectName) {
            // Derive slug from project name: lowercase + replace spaces with hyphens
            sandboxRoot = projectName.toLowerCase().replace(/\s+/g, "-");
          } else {
            console.warn(`Project ${projectId} has no name, agent will use default location`);
          }
        } catch (projectError) {
          console.warn(`Could not fetch existing project ${projectId}:`, projectError);
        }
      }

      setExecutionProgress(15);

      // AUTO-SWITCH TO CODING AGENT: When user clicks "Umsetzen", delegate to dedicated CodingAgent
      // This ensures file-writing operations and disciplined execution with verification
      const executionGoal = `Implementiere diesen Plan:

## ${currentPlan.title || "Plan"}

**Ziel:** ${currentPlan.goal}

**Schritte:**
${
  (currentPlan.steps ?? [])
    .map(
      (step, idx) =>
        `${idx + 1}. **${step.title}**
   ${step.description}${
          step.tools && step.tools.length > 0
            ? `
   Tools: ${step.tools.join(", ")}`
            : ""
        }`
    )
    .join("\n\n")
}

${currentPlan.markdown ? `\n**Detaillierter Plan:**\n${currentPlan.markdown}` : ""}`;

      // Call dedicated CodingAgent endpoint with the plan as goal.
      // CodingAgent has full file-writing permissions and discipline enforcement.
      // Iteration/attempt/timeout budgets now come from /settings > Agenten (server-authoritative):
      // we send the plan's step count and the server picks the SIMPLE/MEDIUM/COMPLEX tier from the
      // persisted settings. calculatedIterations stays only as a fallback for older servers.
      const stepCount = currentPlan.steps?.length ?? 0;
      const calculatedIterations = stepCount <= 3 ? 20 : stepCount <= 7 ? 50 : 100;

      const codingResult = await fetch("/api/coding-agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: executionGoal,
          sandboxRoot: sandboxRoot,
          stepCount,
          maxIterations: calculatedIterations,
        }),
      }).then((r) => r.json());

      // Add execution started message
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "event",
          content: `Coding Agent startet Plan-Umsetzung (${currentPlan.steps?.length ?? 0} Schritte)`,
          timestamp: new Date().toISOString(),
          eventType: "iteration",
          eventData: {
            message: "Coding Agent started executing plan",
            planId: currentPlan.id,
            stepCount: currentPlan.steps?.length ?? 0,
          },
        },
      ]);

      // If CodingAgent execution completed, add result with proper formatting
      if (codingResult?.data) {
        const success = (codingResult.data as any)?.success ?? false;
        let summary = (codingResult.data as any)?.summary ?? "Plan execution completed";
        const attempts = (codingResult.data as any)?.attempts ?? 1;
        const verified = (codingResult.data as any)?.verified ?? false;
        const verifyCommand = (codingResult.data as any)?.verifyCommand;

        // Clean up summary for display - remove excessive markdown or formatting
        // If summary is multi-line, preserve the formatting
        if (typeof summary === "string") {
          summary = summary.trim();
          // Escape JSON if it appears in the summary
          if (summary.includes("{") && summary.includes("}")) {
            // Keep JSON readable with proper formatting
            try {
              const parsed = JSON.parse(summary);
              summary = `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
            } catch {
              // Not valid JSON, keep as-is
            }
          }
        }

        const formattedMessage = `## Plan-Umsetzung ${success ? "✅ erfolgreich" : "❌ fehlgeschlagen"}

**Status:** ${success ? "Abgeschlossen" : "Fehler"}
**Versuche:** ${attempts}/3
**Verifiziert:** ${verified ? "✅ Ja" : "❌ Nein"}${verifyCommand ? `\n**Verifikationbefehl:** \`${verifyCommand}\`` : ""}

---

## Zusammenfassung

${summary}`;

        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: formattedMessage,
            timestamp: new Date().toISOString(),
            eventType: undefined,
            eventData: {
              ...codingResult.data,
              source: "coding_agent",
              executedAt: new Date().toISOString(),
            },
          },
        ]);
      }

      // Close the plan panel
      setShowPlanPanel(false);
      setPlanExecuting(false);
      setExecutionProgress(undefined);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unbekannter Fehler";
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "event",
          content: `Coding Agent Umsetzung fehlgeschlagen: ${errorMsg}`,
          timestamp: new Date().toISOString(),
          eventType: "tool_result",
          eventData: { error: true, message: errorMsg },
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
      setLastProcessedPlanId(lastPlanMessage.id);
      // A fresh plan starts clean - without this, a still-mounted stepStatuses/progress
      // from a previously executed plan would bleed into this one (steps re-indexed from
      // 0 can collide and show as falsely "Erledigt" before anything has run).
      setStepStatuses({});
      setExecutionProgress(0);
      setPlanExecuting(false);

      // Only a CODE plan hands off to the Coding Area. A cowork/general plan stays in the
      // chat and is shown inline. The user's explicit button choice (planKind) is honored
      // strictly - a cowork plan never jumps to coding, even if its content looks code-ish.
      if (planKind === "code") {
        // Hand the plan over via router state. The coding Plan panel derives its plan from
        // the coding project's own conversation messages — which do NOT contain this
        // chat-created plan — so without the handoff the panel shows "Noch kein Plan".
        setTimeout(() => {
          navigate("/coding", { state: { handoffPlan: planData } });
        }, 300);
      }
    }
  };

  useEffect(() => {
    detectPlanFromMessages(lastProcessedPlanId);
  }, [messages, lastProcessedPlanId]);

  // Anchor for "everything that happened during/after this plan's execution" - derived from
  // the plan announcement message's own position instead of a snapshot taken only when
  // "Umsetzen" was clicked. That snapshot didn't survive reopening a conversation later (it
  // reset to -1), which is exactly why step status/progress used to go blank again on reopen.
  // Using the plan message's index instead works identically for a live run and for replaying
  // an already-finished plan from persisted history.
  const planMessageIndex = (() => {
    if (!currentPlan) return -1;
    const baseIdx = messages.findIndex((m) => m.id === lastProcessedPlanId);
    if (baseIdx < 0) return -1;

    // The plan is typically echoed straight back as a plain-text message right after the
    // "plan" event itself (same step titles/numbers, ending in the planner's own "nothing
    // executed yet" sentinel). If the execution scan started there, that echo's step titles
    // would be misread as live progress on a plan that hasn't run at all. Skip past any such
    // not-yet-executed echoes in the few messages right after the plan marker.
    let anchor = baseIdx;
    for (let i = baseIdx + 1; i < Math.min(messages.length, baseIdx + 6); i++) {
      const content = messages[i]?.content?.toLowerCase() ?? "";
      if (content.includes("nur ein plan") || content.includes("noch nichts ausgef")) {
        anchor = i;
      }
    }
    return anchor;
  })();

  // True once every step has been replayed (live or historical) as "completed" - drives
  // hiding the "Umsetzen" button (nothing left to execute) and switching "Plan verbessern"
  // to the file-analysis flow instead of the plain refine-prompt one.
  const isPlanCompleted = Boolean(
    currentPlan?.steps?.length && currentPlan.steps.every((_, idx) => stepStatuses[idx] === "completed")
  );

  // Close plan panel and stop tracking when plan execution completes
  useEffect(() => {
    if (!planExecuting) return;

    // Check if the last message is a completion message
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) return;

    // If we see a completion-like message or if isLoading stopped, finish execution
    if (!isLoading && planMessageIndex >= 0 && messages.length > planMessageIndex + 1) {
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
          // The execution may have just linked this conversation to a (re-)used project
          // server-side - refresh the sidebar's conversation list so the next "improve
          // this plan" round picks up that projectId instead of creating a new project.
          qc.invalidateQueries({ queryKey: ["chat", "conversations", "page"] });
          // Keep panel open for 2 seconds to show completion, then close
          const closeTimer = setTimeout(() => {
            setShowPlanPanel(false);
          }, 2000);
          return () => clearTimeout(closeTimer);
        }
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [planExecuting, isLoading, messages, planMessageIndex, currentPlan?.steps]);

  // Per-step status (and, from it, progress), combining two signals over everything that
  // happened after the plan's own announcement message:
  //
  // 1. Tool usage (primary, deterministic): each plan step carries a "Benoetigte Tools"
  //    hint (currentPlan.steps[i].tools). Real tool_call/tool_result events emitted while
  //    the agent runs carry the actual tool name(s) invoked - matching those against each
  //    step's hint tells us which step is active without depending on the LLM narrating
  //    "Schritt N" in prose, which it often just doesn't do.
  // 2. Explicit "Schritt N" / step-title mentions in the agent's own streamed text
  //    (fallback for steps whose tool hint doesn't distinguish them from a neighbor).
  //
  // Deliberately NOT gated on planExecuting: this must also recompute for a plan reopened
  // from a past conversation whose execution already finished (or is still stuck mid-way),
  // replaying its persisted event history the exact same way live events are replayed - that
  // is what lets the panel show "last known status" instead of resetting to all-pending.
  useEffect(() => {
    if (planMessageIndex < 0 || !currentPlan?.steps) return;

    const steps = currentPlan.steps;
    const stepCount = steps.length;
    if (stepCount === 0) return;

    const executionMessages = messages.slice(planMessageIndex + 1);

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
    // while a run is actively going, default to the first step so it reads as "in progress"
    // instead of sitting on "pending" with no indication anything is happening. Only while
    // planExecuting is true, though: for a plan reopened from history (this session never
    // clicked "Umsetzen"), guessing step 0 is "active" would be misleading if the real
    // signals just didn't catch a finished/interrupted run - "no signal" there should mean
    // "nothing more we know", not "step 1 must be running right now".
    const signaledStep = Math.max(toolActiveStep, maxTextMentionedStep);
    const activeStep = signaledStep >= 0 ? signaledStep : planExecuting ? 0 : -1;

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

    // A plan nobody has touched yet (no execution messages, not currently running) reads as
    // 0% - the "10% for started" floor below only makes sense once something has actually
    // started, live or in the replayed history.
    const hasStarted = planExecuting || executionMessages.length > 0;
    if (!hasStarted) {
      setExecutionProgress(0);
      return;
    }

    const completedCount = Object.values(newStatuses).filter((s) => s === "completed").length;
    const hasInProgress = Object.values(newStatuses).some((s) => s === "in_progress");
    // 10% for "started", the remaining 85% split across steps (half credit for the one
    // currently in progress so the bar keeps creeping forward between step markers).
    const stepFraction = (completedCount + (hasInProgress ? 0.5 : 0)) / stepCount;
    const progress = 10 + stepFraction * 85;
    setExecutionProgress(Math.round(isLoading ? Math.min(95, progress) : progress));
  }, [messages, streamingContent, planExecuting, currentPlan?.steps, planMessageIndex, isLoading]);

  // Listen for real-time phase events from Coding Agent over WebSocket
  useEffect(() => {
    if (!socket || !planExecuting || !currentPlan?.steps) return;

    const handlePhaseEvent = (event: any) => {
      const { type, phase, data } = event;

      // Map phase names to step indices (assuming steps match phases in order)
      const phaseToStepIdx: Record<string, number> = {
        explore: 0,
        plan: 1,
        edit: 2,
        verify: 3,
        report: 4,
      };

      const stepIdx = phaseToStepIdx[phase];
      if (!currentPlan?.steps || stepIdx === undefined || stepIdx >= currentPlan.steps.length) return;

      if (type === "phase_started") {
        setStepStatuses((prev) => ({
          ...prev,
          [stepIdx]: "in_progress",
        }));
      } else if (type === "phase_completed") {
        setStepStatuses((prev) => ({
          ...prev,
          [stepIdx]: "completed",
        }));
      } else if (type === "phase_failed") {
        setStepStatuses((prev) => ({
          ...prev,
          [stepIdx]: "failed",
        }));
      }
    };

    socket.on("coding_agent_event", handlePhaseEvent);
    return () => {
      socket.off("coding_agent_event", handlePhaseEvent);
    };
  }, [socket, planExecuting, currentPlan?.steps]);

  const deleteConversation = useMutation({
    mutationFn: (conversationIdToDelete: number) => api.chat.deleteConversation(conversationIdToDelete),
    onSuccess: async (_data, deletedId) => {
      if (conversationId === deletedId) {
        // Not clearChat(): that only wipes the visible messages and leaves conversationId
        // pointing at the just-deleted row, so the next message sent would try to load a
        // conversation that no longer exists.
        setConversationId(undefined);
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

  const contentWidth = compactMode ? "max-w-3xl" : "max-w-4xl";

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <aside
        ref={conversationsViewportRef}
        onScroll={handleConversationsScroll}
        className={`${chatListOpen ? "block" : "hidden"} ${chatListOpen ? "lg:block" : "lg:hidden"} ${compactMode ? "lg:w-72" : "lg:w-80"} w-full shrink-0 space-y-1 overflow-y-auto border-b border-border bg-card/40 p-2 max-h-[42vh] lg:max-h-screen lg:border-b-0 lg:border-r`}
      >
        <div className="flex items-center justify-between gap-2 px-1 py-1">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t("chat.chats")}</h2>
          <button
            onClick={() => {
              handleNewChat();
            }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            {t("chat.new")}
          </button>
        </div>

        {conversations.map((conv) => (
          <div
            key={conv.id}
            ref={conversationId === conv.id ? activeConversationRef : null}
            className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 transition ${
              conversationId === conv.id
                ? "bg-primary/15 ring-1 ring-primary/40"
                : "hover:bg-accent"
            }`}
          >
            <button
              onClick={() => {
                setMessages([]);
                setExpandedEvents({});
                setConversationId(conv.id);
              }}
              className="min-w-0 flex-1 text-left"
              title={conv.name}
            >
              <div className="truncate text-xs font-medium">{conv.name}</div>
              <div className="text-[10px] text-muted-foreground">{new Date(conv.updatedAt).toLocaleString()}</div>
            </button>
            <button
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-background hover:text-destructive focus:opacity-100 group-hover:opacity-100"
              onClick={() => {
                if (!window.confirm(`${t("layout.sidebar.deleteChatConfirm")}\n\n${conv.name}`)) return;
                deleteConversation.mutate(conv.id);
              }}
              disabled={deleteConversation.isPending}
              title={t("common.delete")}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}

        {conversations.length === 0 && <div className="px-2 py-4 text-xs text-muted-foreground">{t("chat.noSaved")}</div>}
        {conversationsQuery.isFetchingNextPage && (
          <div className="px-2 py-2 text-xs text-muted-foreground">{t("chat.loadingMoreConversations")}</div>
        )}
      </aside>

      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader
          title={conversations.find((c) => c.id === conversationId)?.name}
          conversationId={conversationId}
          chatListOpen={chatListOpen}
          onToggleChatList={toggleChatList}
          compactMode={compactMode}
          onToggleCompact={() => setCompactMode((prev) => !prev)}
          onClear={() => {
            if (conversationId) clearMessages.mutate(conversationId);
            else clearChat();
          }}
          onOpenSettings={() => setShowSettings((prev) => !prev)}
          isLoading={isLoading}
          connected={connected}
        />

        {showSettings && (
          <div className="shrink-0 border-b border-border bg-card/50 px-4 py-3">
            <div className={`mx-auto w-full ${contentWidth} space-y-4`}>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">{t("chat.chatSettings")}</h3>
                <button
                  onClick={() => setShowSettings(false)}
                  className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">{t("settings.duckaAnimation")}</p>
                <div className="flex gap-1.5">
                  {(["matrix", "neon", "minimal"] as const).map((style) => (
                    <button
                      key={style}
                      onClick={() => useAppStore.setState({ animationStyle: style })}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
                        animationStyle === style
                          ? "bg-primary text-primary-foreground"
                          : "border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                      }`}
                    >
                      {style}
                    </button>
                  ))}
                </div>
              </div>

              <div className="border-t border-border pt-4">
                <BrowserSessionManager />
              </div>
            </div>
          </div>
        )}

        {/* Messages - oldest at top, newest at bottom */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={messagesViewportRef}
            onScroll={handleMessagesScroll}
            className="h-full overflow-y-auto px-3 py-4 pb-40 sm:px-6"
          >
            <div className={`mx-auto w-full ${contentWidth} ${compactMode ? "space-y-4" : "space-y-6"}`}>
              {selectedConversationMessages.isFetchingNextPage && (
                <div className="text-center text-xs text-muted-foreground">{t("chat.loadingOlderMessages")}</div>
              )}

              {messages.length === 0 && !isLoading && (
                <ChatWelcome
                  characterId={selectedCharacterId}
                  characterCustomizations={characterCustomizations}
                  onPick={(prompt) => setInput(prompt)}
                />
              )}

              {renderItems.map((item, itemIndex) =>
                item.kind === "toolGroup" ? (
                  <ToolGroupRow
                    key={item.id}
                    events={item.events}
                    t={t}
                    live={itemIndex === renderItems.length - 1}
                    expanded={expandedToolGroups[item.id] ?? false}
                    onToggle={(isOpen) => setExpandedToolGroups((prev) => ({ ...prev, [item.id]: isOpen }))}
                    expandedChildren={expandedEvents}
                    onToggleChild={(id, isOpen) => setExpandedEvents((prev) => ({ ...prev, [id]: isOpen }))}
                  />
                ) : item.msg.role === "event" ? (
                  <EventRow
                    key={item.msg.id}
                    msg={item.msg}
                    t={t}
                    expanded={expandedEvents[item.msg.id] ?? defaultExpandedForType(item.msg.eventType)}
                    onToggle={(isOpen) => setExpandedEvents((prev) => ({ ...prev, [item.msg.id]: isOpen }))}
                  />
                ) : (
                  <MessageRow
                    key={item.msg.id}
                    msg={item.msg}
                    compactMode={compactMode}
                    onResend={item.msg.role === "user" ? () => setInput(item.msg.content) : undefined}
                    t={t}
                  />
                )
              )}

              {/* Real-time token tracking */}
              {conversationId && socket && <IterationMetrics conversationId={conversationId.toString()} socket={socket} />}

              {/* Tool execution summaries, rendered as chat events once complete */}
              {toolSummaries.map((summary) => (
                <ToolEventSummary
                  key={summary.id}
                  events={summary.events}
                  onDismiss={() => setToolSummaries((prev) => prev.filter((s) => s.id !== summary.id))}
                />
              ))}

              {(isLoading || persistentStreamingContent.trim().length > 0) && (
                <div className="flex items-end gap-3">
                  <div className="min-w-0 flex-1">
                    <StreamingRow compactMode={compactMode} streamingContent={persistentStreamingContent} t={t} />
                  </div>
                  <div className="hidden shrink-0 sm:block">
                    <DynamicCharacter
                      isWorking={isLoading}
                      size={56}
                      characterId={selectedCharacterId}
                      customConfig={characterCustomizations}
                    />
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          </div>

          {showScrollDown && (
            <button
              onClick={() => {
                stickToBottomRef.current = true;
                bottomRef.current?.scrollIntoView({ behavior: "smooth" });
              }}
              title={t("chat.scrollToBottom")}
              className="absolute bottom-3 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card shadow-lg transition hover:bg-accent"
            >
              <ArrowDown className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Composer area - live tool progress sits directly above the input */}
        <div className="shrink-0 px-3 pb-3 sm:px-6">
          <div className={`mx-auto w-full ${contentWidth} space-y-2`}>
            {conversationId && socket && (
              <ToolEventsDisplay
                conversationId={conversationId.toString()}
                socket={socket}
                onToolExecutionComplete={(summary) => {
                  setToolSummaries((prev) => [...prev, { id: summary.id, events: summary.events }]);
                }}
              />
            )}

            <ChatComposer
              value={input}
              onChange={setInput}
              onSend={() => void handleSend()}
              onStop={stopMessage}
              isLoading={isLoading}
              uploading={uploading}
              attachedFiles={attachedFiles}
              onAttachFiles={(files) => setAttachedFiles((prev) => [...prev, ...files])}
              onRemoveFile={(index) => setAttachedFiles((prev) => prev.filter((_, i) => i !== index))}
              analyzeImages={analyzeImages}
              onToggleAnalyzeImages={() => setAnalyzeImages((v) => !v)}
              planKind={planKind}
              onSelectPlanKind={(kind) => setPlanKind((prev) => (prev === kind ? null : kind))}
              conversationId={conversationId}
              onInsertSkill={handleInsertSkill}
              onToolExecuted={handleToolExecuted}
              totalTokens={totalTokens}
            />
          </div>
        </div>
      </div>

      {/* Browser Preview Modal */}
      {browserPreview.showModal && browserPreview.currentPreview && (
        <BrowserPreviewModal
          data={browserPreview.currentPreview}
          onClose={() => setBrowserPreviewModal(false)}
        />
      )}

      {/* Tool Response Dock - only show tool calls for current conversation */}
      {showToolDock && toolCalls.length > 0 && (
        <ToolResponseDock
          toolCalls={toolCalls.filter(call => call.conversationId === conversationId)}
          onRemove={removeToolCall}
        />
      )}
    </div>
  );
}
