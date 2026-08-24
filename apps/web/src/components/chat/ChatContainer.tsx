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
import { type Plan } from "./PlanExecutionPanel";
import { BrowserPreviewModal } from "./BrowserPreview";
import { ProjectSkillsBanner } from "./ProjectSkillsBanner";
import { ToolEventsDisplay } from "./ToolEventsDisplay";
import { ToolEventSummary } from "./ToolEventSummary";
import { IterationMetrics } from "./IterationMetrics";
import type { AgentEventType, RenderedChatMessage } from "./chatTypes";
import { parsePersistedEvent } from "../../lib/persistedEventTypes";
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
          const { eventType, eventData } = parsePersistedEvent(msg.toolResult);

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
    let visionOnly = false;
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
        // "Bildanalyse" fast path: the image now rides directly in the message content sent
        // to the model (see runVisionMode/buildUserTurnContent server-side), so the old
        // "please analyze - here are the paths" text would just tell the model to go search
        // for a file it already has in front of it. Only append the plain attachment list;
        // the vision system prompt covers the instruction.
        visionOnly = analyzeImages && imagePaths.length > 0;
        const list = attachments.map((a) => `- shared-workspace/${a.path}`).join("\n");
        uploadSummary = `\n\n${t("chat.attachedFilesHeader")}\n${list}`;
        if (!visionOnly && analyzeImages && imagePaths.length > 0) {
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
      chatModel,
      visionOnly
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

  // Chat -> Coding Area handoff: a finished CODE plan (planKind === "code") navigates to
  // /coding with the plan attached, where CodingPlanPanel/CodingAgentPanel take over
  // (execution, refinement, per-step progress). A cowork/general plan stays in the chat and
  // is shown inline via the generic "plan" event message - see eventMeta.tsx. This used to
  // live inside a much larger cluster (dead panel/progress-tracking state that was never
  // actually rendered - see history) - only the handoff itself was reachable.
  const lastHandedOffPlanId = useRef<string | null>(null);
  useEffect(() => {
    if (planKind !== "code") return;
    const lastPlanMessage = [...messages]
      .reverse()
      .find((msg) => msg.eventType === "plan" && (msg.eventData as { source?: string } | undefined)?.source === "plan_mode");
    if (!lastPlanMessage?.eventData || lastPlanMessage.id === lastHandedOffPlanId.current) return;

    const planData = lastPlanMessage.eventData as unknown as Plan;
    if (!planData.goal || !Array.isArray(planData.steps) || planData.steps.length === 0) return;

    lastHandedOffPlanId.current = lastPlanMessage.id;
    // Hand the plan over via router state. The coding Plan panel derives its plan from the
    // coding project's own conversation messages — which do NOT contain this chat-created
    // plan — so without the handoff the panel shows "Noch kein Plan".
    //
    // Deliberately NOT cleaned up via clearTimeout: a message that lands right after this one
    // (e.g. the "Plan gespeichert" guardrail event) changes `messages` again within the 300ms
    // window, re-running this effect. A cleanup-cancelled timer would then never be replaced -
    // the ref guard above already makes this one-shot, so nothing needs cancelling.
    setTimeout(() => {
      navigate("/coding", { state: { handoffPlan: planData } });
    }, 300);
  }, [messages, planKind, navigate]);

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

        <ProjectSkillsBanner />

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
