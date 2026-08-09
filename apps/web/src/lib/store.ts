import { create } from "zustand";
import { io, type Socket } from "socket.io-client";
import { translations, type Language, type TranslationTree } from "./translations";
import type { AgentEventType } from "../components/chat/chatTypes";
import { getSocketUrl } from "./backendUrl";
import { useConnectionStore } from "./connectionStore";
import { api } from "./api";

const LANGUAGE_STORAGE_KEY = "ducki.language";
const CLIENT_ID_KEY = "ducki.clientId";

/** Payload of the server's handshake reply. */
export interface ServerHelloSnapshot {
  agents?: { runningCount?: number; agents?: unknown[] };
  gateway?: unknown;
}

/** Counts consecutive socket connect failures so the console logging can be throttled. */
let connectErrorCount = 0;

/** Stable per-browser id, so the server log can tell reconnects from new clients apart. */
function getClientId(): string {
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const generated = crypto.randomUUID();
    window.localStorage.setItem(CLIENT_ID_KEY, generated);
    return generated;
  } catch {
    return "anonymous";
  }
}

function getNestedValue(tree: TranslationTree, key: string): string | undefined {
  const segments = key.split(".");
  let current: unknown = tree;

  for (const segment of segments) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === "string" ? current : undefined;
}

function getCurrentLanguage(): Language {
  const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (saved === "de" || saved === "en") return saved;

  const browser = navigator.language.toLowerCase();
  return browser.startsWith("de") ? "de" : "en";
}

function t(key: string): string {
  const language = getCurrentLanguage();
  return getNestedValue(translations[language], key) ?? getNestedValue(translations.de, key) ?? key;
}

function formatChatErrorMessage(rawError: string): string {
  const normalized = rawError.toLowerCase();

  if (normalized.includes("without progress") || normalized.includes("progress timeout")) {
    const match = rawError.match(/(\d+)ms/);
    const timeoutMs = match?.[1];
    const base = t("chat.timeoutNoProgress");
    return timeoutMs ? `${base} (${timeoutMs} ms).` : base;
  }

  return `${t("chat.errorPrefix")} ${rawError}`;
}

function normalizeAssistantContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

// Callback registry for query cache invalidation
// This allows ChatContainer to register a callback that syncs the query cache
let onChatCompleteCallback: ((conversationId: number, response: string, messageId: string) => void) | null = null;
export function registerChatCompleteCallback(callback: ((conversationId: number, response: string, messageId: string) => void) | null) {
  onChatCompleteCallback = callback;
}

export interface ChatAttachment {
  name: string;
  path?: string;
  url?: string;
  mimeType?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "event" | "tool";
  content: string;
  timestamp: string;
  eventType?: AgentEventType;
  eventData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface ChatEvent {
  type: AgentEventType;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
  conversationId?: number;
}

interface BrowserPreviewState {
  showModal: boolean;
  currentPreview?: {
    tabId?: string;
    serverId?: string;
    url?: string;
    screenshot?: string;
    htmlContent?: string;
  };
}

export interface BrowserSession {
  tabId: string;
  url: string;
  title?: string;
  isActive: boolean;
  cookies?: string[];
  lastUsed: string;
  isDefault?: boolean;
}

export interface ToolCallRecord {
  id: string;
  toolName: string;
  action?: string;
  timestamp: string;
  input?: Record<string, unknown>;
  status: "executing" | "completed" | "failed";
  result?: {
    success: boolean;
    output?: string;
    error?: string;
    data?: unknown;
  };
  tabId?: string;
  conversationId?: number; // Link to chat conversation - allows per-chat filtering
}

interface AppState {
  // Agent
  agentStatus: "idle" | "running" | "paused" | "error" | "stopped";

  // Chat
  messages: ChatMessage[];
  conversationId: number | undefined;
  sessionChatId: string | undefined;
  awaitingNewConversation: boolean;
  pendingLocalMessageId?: string;
  runningConversationIds: Set<number>;
  isLoading: boolean;
  streamingContent: string;
  globalRunningAgents: number;
  chatProvider?: string;
  chatModel?: string;
  availableModels: string[];
  loadingModels: boolean;

  // Socket
  socket: Socket | null;
  connected: boolean;
  /** Pushed by the server on every change - replaces the 1.5s agents.live() poll. */
  agentMetrics?: ServerHelloSnapshot["agents"];
  /** Travels with the handshake and with agent:metrics. */
  gatewayStatus?: unknown;

  // UI
  setupModalOpen: boolean;
  browserPreview: BrowserPreviewState;
  animationStyle: "matrix" | "neon" | "minimal";

  // Character System (NEW)
  selectedCharacterId: string;
  characterCustomizations: Record<string, unknown>;

  // Tool Management
  toolCalls: ToolCallRecord[];
  browserSessions: BrowserSession[];
  showToolDock: boolean;
  runningTools: Set<string>;

  // Actions
  initSocket: () => void;
  disconnectSocket: () => void;
  sendMessage: (
    content: string,
    attachments?: ChatAttachment[],
    agentMode?: AgentMode,
    /** What to show in the chat when `content` carries extra machine-facing context. */
    displayContent?: string,
    provider?: string,
    model?: string
  ) => Promise<void>;
  handleNewChat: () => void;
  stopMessage: () => void;
  clearChat: () => void;
  setConversationId: (id: number | undefined) => void;
  setMessages: (messages: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  setAgentStatus: (status: AppState["agentStatus"]) => void;
  setGlobalRunningAgents: (count: number) => void;
  setSetupModalOpen: (open: boolean) => void;
  setBrowserPreviewModal: (show: boolean, preview?: BrowserPreviewState["currentPreview"]) => void;
  setAnimationStyle: (style: "matrix" | "neon" | "minimal") => void;
  setChatProvider: (provider: string | undefined) => void;
  setChatModel: (model: string | undefined) => void;
  setAvailableModels: (models: string[]) => void;
  setLoadingModels: (loading: boolean) => void;

  // Character System (NEW)
  setSelectedCharacterId: (id: string) => void;
  setCharacterCustomizations: (customizations: Record<string, unknown>) => void;
  updateCharacterCustomization: (key: string, value: unknown) => void;

  // Tool Management
  addToolCall: (toolCall: ToolCallRecord) => void;
  updateToolCall: (id: string, updates: Partial<ToolCallRecord>) => void;
  removeToolCall: (id: string) => void;
  clearToolCalls: () => void;
  addBrowserSession: (session: BrowserSession) => void;
  updateBrowserSession: (tabId: string, updates: Partial<BrowserSession>) => void;
  setRunningTools: (tools: Set<string>) => void;
  removeBrowserSession: (tabId: string) => void;
  setShowToolDock: (show: boolean) => void;
  refreshBrowserSessions: () => Promise<void>;
  controlBrowserSession: (
    sessionId: string,
    action: string,
    params?: Record<string, unknown>
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>;
}

export type AgentMode = "full" | "plan";

export const useAppStore = create<AppState>((set, get) => ({
  agentStatus: "idle",
  messages: [],
  conversationId: undefined,
  sessionChatId: undefined,
  awaitingNewConversation: false,
  pendingLocalMessageId: undefined,
  runningConversationIds: new Set(),
  isLoading: false,
  streamingContent: "",
  globalRunningAgents: 0,
  socket: null,
  connected: false,
  setupModalOpen: false,
  animationStyle: "matrix",
  chatProvider: undefined,
  chatModel: undefined,
  availableModels: [],
  loadingModels: false,
  browserPreview: {
    showModal: false,
    currentPreview: undefined,
  },
  // Character System (NEW)
  selectedCharacterId: "duck-matrix",
  characterCustomizations: {},
  toolCalls: [],
  browserSessions: [],
  showToolDock: true,
  runningTools: new Set(),

  initSocket: () => {
    const existingSocket = get().socket;
    if (existingSocket) {
      return;
    }

    // getSocketUrl honours a "remote" backend in the browser too. Previously that was
    // only applied on desktop, so a browser pointed at a remote backend sent its HTTP
    // requests there but kept the socket on its own origin.
    const socketUrl = getSocketUrl();

    useConnectionStore.getState().markConnecting();

    const socket = io(socketUrl, {
      path: "/socket.io",
      // websocket first, but fall back to HTTP long-polling. Polling matters when the
      // page is served from a public https origin and the backend is on a local address
      // (127.0.0.1/LAN): Chrome's Private Network Access preflight rides the HTTP path,
      // which the server allows, whereas a bare ws:// upgrade can be blocked.
      transports: ["websocket", "polling"],
      // Bounded, jittered backoff instead of the default tight retry loop - a server
      // that is down should cost a handful of attempts per minute, not a stream.
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000,
      randomizationFactor: 0.5,
      timeout: 8000,
    });

    // The socket being open is not the same as the server being usable: announce
    // ourselves and wait for the reply before anything starts issuing requests.
    socket.on("connect", () => {
      socket.emit("client:hello", {
        clientId: getClientId(),
        appVersion: import.meta.env["VITE_APP_VERSION"] ?? "dev",
      });
    });

    socket.on("server:hello", (data: { protocolVersion?: number; snapshot?: ServerHelloSnapshot }) => {
      useConnectionStore.getState().markReady(data?.protocolVersion);
      connectErrorCount = 0;
      // The handshake snapshot replaces the burst of requests the client used to fire
      // on startup just to learn the agent and gateway state.
      const snapshot = data?.snapshot;
      set({
        connected: true,
        globalRunningAgents: snapshot?.agents?.runningCount ?? 0,
        agentMetrics: snapshot?.agents,
        gatewayStatus: snapshot?.gateway,
      });
    });

    const handleLost = (reason: string) => {
      useConnectionStore.getState().markLost(reason);
      const disconnectMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "event",
        content: t("chat.socketDisconnectedDuringRun"),
        timestamp: new Date().toISOString(),
        eventType: "guardrail",
      };
      set((s) => ({
        connected: false,
        isLoading: false,
        streamingContent: "",
        runningConversationIds: new Set(),
        messages: s.isLoading ? [...s.messages, disconnectMsg] : s.messages,
      }));
    };

    socket.on("server:bye", () => handleLost("server shutdown"));
    socket.on("disconnect", (reason: string) => handleLost(reason));

    socket.on("connect_error", (error: Error) => {
      connectErrorCount += 1;
      // Every single attempt used to write to the console. Report the first failure and
      // then only occasionally, so a backend that is simply not running stays readable.
      if (connectErrorCount === 1 || connectErrorCount % 10 === 0) {
        console.warn(
          `[socket] connection failed (attempt ${connectErrorCount}): ${error.message}`
        );
      }
      useConnectionStore.getState().markLost(error.message);
      set({ connected: false, isLoading: false, streamingContent: "" });
    });

    // A run's events belong to the currently displayed chat only if their conversationId
    // matches. For a brand-new chat that is still unbound (conversationId undefined), only
    // unscoped events (without conversationId) are accepted until chat:conversation binds it.
    // This prevents an older still-running chat from leaking events into the newly opened chat.
    const belongsToActiveConversation = (eventConversationId?: number): boolean => {
      const s = get();
      if (s.conversationId === eventConversationId) return true;
      if (eventConversationId === undefined) {
        return s.awaitingNewConversation && s.conversationId === undefined;
      }
      return false;
    };

    socket.on("chat:conversation", (data: { conversationId: number }) => {
      set((s) => {
        if (!s.awaitingNewConversation) return {};
        return { conversationId: data.conversationId, awaitingNewConversation: false };
      });
    });

    socket.on("chat:start", (data: { conversationId?: number }) => {
      if (!belongsToActiveConversation(data.conversationId)) return;
      set((s) => {
        const nextRunning = new Set(s.runningConversationIds);
        if (typeof data.conversationId === "number") {
          nextRunning.add(data.conversationId);
        }
        return { isLoading: true, streamingContent: "", runningConversationIds: nextRunning };
      });
    });

    socket.on("chat:event", (event: ChatEvent) => {
      if (!belongsToActiveConversation(event.conversationId)) return;
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "event",
        content: event.message,
        timestamp: event.timestamp,
        eventType: event.type,
        eventData: event.data,
      };

      set((s) => {
        // Update toolCalls if this is a tool_call or tool_result event
        let updatedToolCalls = s.toolCalls;

        if (event.type === "tool_call" && event.data) {
          const toolName = event.data.toolName as string | undefined;
          if (toolName) {
            // Add new tool call - link to current conversation
            const newToolCall: ToolCallRecord = {
              id: crypto.randomUUID(),
              toolName,
              timestamp: event.timestamp,
              status: "executing",
              input: event.data.input as Record<string, unknown>,
              conversationId: s.conversationId, // Link to current chat
            };
            updatedToolCalls = [...s.toolCalls, newToolCall];
          }
        } else if (event.type === "tool_result" && event.data) {
          // Update tool call with result
          const toolName = event.data.toolName as string | undefined;
          if (toolName) {
            updatedToolCalls = s.toolCalls.map((call) => {
              if (call.toolName === toolName && call.status === "executing") {
                return {
                  ...call,
                  status: (event.data?.success === false ? "failed" : "completed") as "completed" | "failed",
                  result: {
                    success: (event.data?.success as boolean) ?? true,
                    output: event.message,
                    data: event.data?.data,
                    error: event.data?.error as string | undefined,
                  },
                };
              }
              return call;
            });
          }
        }

        return {
          messages: [...s.messages, msg],
          toolCalls: updatedToolCalls,
        };
      });
    });

    socket.on("chat:chunk", (data: { content: string; conversationId?: number }) => {
      if (!belongsToActiveConversation(data.conversationId)) return;
      set((s) => ({ streamingContent: s.streamingContent + data.content }));
    });

    socket.on("chat:complete", (data: { response: string; conversationId?: number; messageId?: string }) => {
      console.log("[store] chat:complete received", {
        responseLength: data.response?.length,
        responsePreview: data.response?.substring(0, 100),
        conversationId: data.conversationId,
        messageId: data.messageId,
      });
      if (!belongsToActiveConversation(data.conversationId)) {
        console.log("[store] chat:complete ignored - not active conversation");
        return;
      }
      const msgTimestamp = new Date().toISOString();
      set((s) => ({
        ...(() => {
          const localTurnId = s.pendingLocalMessageId;
          const msg: ChatMessage = {
            id: data.messageId || crypto.randomUUID(),
            role: "assistant",
            content: data.response,
            timestamp: msgTimestamp,
            metadata: {
              localMessageId: localTurnId,
              serverMessageId: data.messageId,
            },
          };

          // Skip if exact same message ID already exists (true duplicate)
          const alreadyPresentById = s.messages.some((existing) => existing.id === msg.id);
          if (alreadyPresentById) {
            console.debug("[store.chat:complete] Message already exists by ID, skipping duplicate", {
              messageId: msg.id,
              contentPreview: data.response.substring(0, 100),
            });
            const nextRunning = new Set(s.runningConversationIds);
            if (typeof data.conversationId === "number") {
              nextRunning.delete(data.conversationId);
            }
            return {
              isLoading: false,
              streamingContent: "",
              pendingLocalMessageId: undefined,
              runningConversationIds: nextRunning,
            };
          }

          // Only skip if empty response (not a valid message worth showing)
          // Don't deduplicate based on recent content - the server sent this for a reason
          if (!data.response.trim()) {
            console.debug("[store.chat:complete] Empty response, skipping", {
              messageId: msg.id,
            });
            const nextRunning = new Set(s.runningConversationIds);
            if (typeof data.conversationId === "number") {
              nextRunning.delete(data.conversationId);
            }
            return {
              isLoading: false,
              streamingContent: "",
              pendingLocalMessageId: undefined,
              runningConversationIds: nextRunning,
            };
          }

          const nextRunning = new Set(s.runningConversationIds);
          if (typeof data.conversationId === "number") {
            nextRunning.delete(data.conversationId);
            // Add message directly to React Query cache to avoid race conditions
            setTimeout(() => onChatCompleteCallback?.(data.conversationId as number, data.response, msg.id), 0);
          }

          return {
            messages: [...s.messages, msg],
            isLoading: false,
            streamingContent: "",
            pendingLocalMessageId: undefined,
            runningConversationIds: nextRunning,
          };
        })(),
      }));
    });

    socket.on("chat:stopped", (data: { conversationId?: number }) => {
      if (!belongsToActiveConversation(data.conversationId)) return;
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "event",
        content: t("chat.executionStopped"),
        timestamp: new Date().toISOString(),
        eventType: "reasoning",
      };
      set((s) => ({
        ...(() => {
          const nextRunning = new Set(s.runningConversationIds);
          if (typeof data.conversationId === "number") {
            nextRunning.delete(data.conversationId);
          }
          return {
            messages: [...s.messages, msg],
            isLoading: false,
            streamingContent: "",
            pendingLocalMessageId: undefined,
            runningConversationIds: nextRunning,
          };
        })(),
      }));
    });

    socket.on("chat:error", (data: { error: string; conversationId?: number }) => {
      if (!belongsToActiveConversation(data.conversationId)) return;
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: formatChatErrorMessage(data.error),
        timestamp: new Date().toISOString(),
      };
      set((s) => ({
        ...(() => {
          const nextRunning = new Set(s.runningConversationIds);
          if (typeof data.conversationId === "number") {
            nextRunning.delete(data.conversationId);
          }
          return {
            messages: [...s.messages, msg],
            isLoading: false,
            streamingContent: "",
            pendingLocalMessageId: undefined,
            runningConversationIds: nextRunning,
          };
        })(),
      }));
    });

    socket.on("agent:status", (data: { status: AppState["agentStatus"] }) => {
      set({ agentStatus: data.status });
    });

    // Pushed on every registry change. Consumers read this from the store instead of
    // polling /agents/live, which is where most of the idle request load came from.
    socket.on("agent:metrics", (data: { runningCount?: number; agents?: unknown[]; gateway?: unknown }) => {
      set({
        globalRunningAgents: Number(data?.runningCount ?? 0),
        agentMetrics: { runningCount: Number(data?.runningCount ?? 0), agents: data?.agents },
        ...(data?.gateway !== undefined ? { gatewayStatus: data.gateway } : {}),
      });
    });

    // A settings write is announced instead of polled for; the query layer listens.
    socket.on("settings:changed", (data: { keys?: string[] }) => {
      window.dispatchEvent(new CustomEvent("ducki:settings-changed", { detail: data }));
    });

    socket.on("browser:preview", (data: { tabId?: string; serverId?: string; url?: string; screenshot?: string; htmlContent?: string; conversationId?: number }) => {
      if (!belongsToActiveConversation(data.conversationId)) return;
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "event",
        content: `Browser preview: ${data.url || "preview"}`,
        timestamp: new Date().toISOString(),
        eventType: "browser_preview",
        eventData: {
          tabId: data.tabId,
          serverId: data.serverId,
          url: data.url,
          screenshot: data.screenshot,
          htmlContent: data.htmlContent,
          isStreaming: true,
        },
      };
      set((s) => ({
        messages: [...s.messages, msg],
      }));
      // A new/updated session just became visible - keep the session panel in sync.
      void get().refreshBrowserSessions();
    });

    // Tool call tracking
    socket.on("tool:call_started", (data: { timestamp: string; conversationId?: number; data?: Record<string, unknown> }) => {
      if (!belongsToActiveConversation(data.conversationId)) return;
      const toolData = data.data as { count?: number; tools?: string[]; summaries?: string[]; callIds?: string[] } | undefined;
      const tools = toolData?.tools ?? [];
      const summaries = toolData?.summaries ?? [];
      const callIds = toolData?.callIds ?? [];

      // Create tool calls for each tool (tools and summaries arrays have same length)
      for (let i = 0; i < tools.length; i++) {
        // Use the id the agent will also stamp on the matching tool_result event so the
        // completion can be correlated exactly. Fall back to a synthesized id for older
        // event payloads that don't carry callIds.
        const callId = callIds[i] ?? `${tools[i]}_${data.timestamp}_${i}`;
        const toolCall: ToolCallRecord = {
          id: callId,
          toolName: tools[i] ?? "unknown",
          timestamp: data.timestamp,
          status: "executing",
          input: { summary: summaries[i], toolName: tools[i] },
          conversationId: data.conversationId,
        };
        get().addToolCall(toolCall);
      }
    });

    socket.on("tool:call_completed", (data: { timestamp: string; conversationId?: number; data?: Record<string, unknown> }) => {
      if (!belongsToActiveConversation(data.conversationId)) return;
      const toolData = data.data as { toolName?: string; callId?: string; success?: boolean; error?: string; summary?: string; disposition?: string } | undefined;
      const toolName = toolData?.toolName ?? "unknown";
      const callId = toolData?.callId;

      // Find the tool call by exact callId if available, otherwise by toolName
      const toolCalls = get().toolCalls;
      let toolCall = undefined;

      if (callId) {
        // Prefer matching by exact callId for precision
        toolCall = toolCalls.find((tc) => tc.id === callId);
      }

      if (!toolCall) {
        // Fallback: match by toolName for backward compatibility
        toolCall = toolCalls.find(
          (tc) => tc.toolName === toolName && tc.status === "executing"
        );
      }

      if (toolCall) {
        get().updateToolCall(toolCall.id, {
          status: toolData?.success ? "completed" : "failed",
          result: toolData?.success
            ? { success: true, output: toolData.summary }
            : { success: false, error: toolData?.error ?? "Unknown error" },
        });
      } else {
        // Log when tool call is not found (helps debug missing responses)
        console.warn("[store.tool:call_completed] Tool call not found", {
          toolName,
          callId,
          success: toolData?.success,
          error: toolData?.error,
          activeToolCalls: toolCalls.map((tc) => ({ id: tc.id, toolName: tc.toolName, status: tc.status })),
        });
      }
    });

    set({ socket });
  },

  disconnectSocket: () => {
    get().socket?.disconnect();
    set({ socket: null, connected: false });
  },

  sendMessage: async (content: string, attachments?: ChatAttachment[], agentMode?: AgentMode, displayContent?: string, provider?: string, model?: string) => {
    const { socket, conversationId, sessionChatId, isLoading } = get();
    if (!socket || !content.trim() || isLoading) return;

    const messageId = crypto.randomUUID();
    const userMsg: ChatMessage = {
      id: messageId,
      role: "user",
      // Callers that wrap the prompt in machine-facing context (the coding workspace
      // prepends a [CODING_CONTEXT] block) pass what the user actually typed here, so the
      // chat shows their message instead of the scaffolding around it.
      content: displayContent ?? content,
      timestamp: new Date().toISOString(),
      // CRITICAL FIX #1: Store the local UUID in metadata so we can link it to the DB ID
      // when the message is persisted. This enables deduplication when undefined→defined
      // conversationId transition happens.
      metadata: {
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        localMessageId: messageId,  // Link to DB when persisted
      },
    };

    // Set isLoading synchronously (not waiting for the server's "chat:start" ack) so the
    // send button/Enter key are disabled immediately. Without this, a second message fired
    // before the round-trip completes would still see conversationId as undefined and cause
    // the server to spin up a brand-new conversation per message instead of reusing one.
    set((s) => ({
      messages: [...s.messages, userMsg],
      isLoading: true,
      streamingContent: "",
      pendingLocalMessageId: messageId,
      // Conversation id is now created up-front before starting the agent run.
      awaitingNewConversation: false,
    }));

    try {
      let resolvedConversationId = conversationId;
      if (resolvedConversationId === undefined) {
        const created = await api.chat.createConversation({
          name: content.trim().slice(0, 80),
        });
        resolvedConversationId = created.conversationId;

        set((s) => {
          const nextRunning = new Set(s.runningConversationIds);
          nextRunning.add(resolvedConversationId!);
          return {
            conversationId: resolvedConversationId,
            awaitingNewConversation: false,
            runningConversationIds: nextRunning,
          };
        });
      }

      socket.emit("chat:message", {
        message: content,
        conversationId: resolvedConversationId,
        sessionChatId,
        attachments,
        agentMode,
        provider,
        model,
        localMessageId: messageId,
      });
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: formatChatErrorMessage(errorText),
            timestamp: new Date().toISOString(),
          },
        ],
        isLoading: false,
        streamingContent: "",
        pendingLocalMessageId: undefined,
      }));
    }
  },

  handleNewChat: () => {
    const newSessionId = crypto.randomUUID();
    set({
      conversationId: undefined,
      sessionChatId: newSessionId,
      messages: [],
      streamingContent: "",
      isLoading: false,
      pendingLocalMessageId: undefined,
      agentStatus: "idle",
      toolCalls: [],
    });
  },

  stopMessage: () => {
    const { socket, conversationId } = get();
    if (!socket) return;
    socket.emit("chat:stop", { conversationId });
  },

  clearChat: () => set({ messages: [] }),
  setConversationId: (id) =>
    set((s) => ({
      conversationId: id,
      messages: s.conversationId !== id ? [] : s.messages, // Only clear messages when switching to a DIFFERENT conversation
      awaitingNewConversation: false,
      isLoading: typeof id === "number" ? s.runningConversationIds.has(id) : false,
      streamingContent: "",
    })),
  setMessages: (messages) =>
    set((s) => ({
      messages: typeof messages === "function" ? messages(s.messages) : messages,
    })),
  setAgentStatus: (status) => set({ agentStatus: status }),
  setGlobalRunningAgents: (count) => set({ globalRunningAgents: Math.max(0, count) }),
  setSetupModalOpen: (open) => set({ setupModalOpen: open }),
  setBrowserPreviewModal: (show, preview) =>
    set({
      browserPreview: {
        showModal: show,
        currentPreview: preview,
      },
    }),
  setAnimationStyle: (style) => set({ animationStyle: style }),

  // Chat Provider & Model Selection
  setChatProvider: (provider) => set({ chatProvider: provider }),
  setChatModel: (model) => set({ chatModel: model }),
  setAvailableModels: (models) => set({ availableModels: models }),
  setLoadingModels: (loading) => set({ loadingModels: loading }),

  // Tool Management
  addToolCall: (toolCall) =>
    set((s) => ({
      toolCalls: [...s.toolCalls, toolCall],
    })),
  updateToolCall: (id, updates) =>
    set((s) => ({
      toolCalls: s.toolCalls.map((call) =>
        call.id === id ? { ...call, ...updates } : call
      ),
    })),
  removeToolCall: (id) =>
    set((s) => ({
      toolCalls: s.toolCalls.filter((call) => call.id !== id),
    })),
  clearToolCalls: () => set({ toolCalls: [] }),

  addBrowserSession: (session) =>
    set((s) => ({
      browserSessions: [...s.browserSessions, session],
    })),
  updateBrowserSession: (tabId, updates) =>
    set((s) => ({
      browserSessions: s.browserSessions.map((session) =>
        session.tabId === tabId ? { ...session, ...updates } : session
      ),
    })),
  removeBrowserSession: (tabId) =>
    set((s) => ({
      browserSessions: s.browserSessions.filter((session) => session.tabId !== tabId),
    })),
  setShowToolDock: (show) => set({ showToolDock: show }),
  setRunningTools: (tools) => set({ runningTools: tools }),

  refreshBrowserSessions: () => {
    const socket = get().socket;
    if (!socket) return Promise.resolve();
    return new Promise<void>((resolve) => {
      socket.emit(
        "browser:list",
        {},
        (result: {
          success: boolean;
          data?: { sessions?: Array<{ sessionId: string; url: string; title?: string; launchedAt: string; isDefault: boolean }> };
        }) => {
          if (result?.success && result.data?.sessions) {
            const sessions: BrowserSession[] = result.data.sessions.map((s) => ({
              tabId: s.sessionId,
              url: s.url,
              title: s.title,
              isActive: true,
              lastUsed: s.launchedAt,
              isDefault: s.isDefault,
            }));
            set({ browserSessions: sessions });
          }
          resolve();
        }
      );
    });
  },
  controlBrowserSession: (sessionId, action, params) => {
    const socket = get().socket;
    if (!socket) return Promise.resolve({ success: false, error: "Not connected" });
    return new Promise((resolve) => {
      socket.emit(
        "browser:control",
        { sessionId, action, ...params },
        (result: { success: boolean; data?: unknown; error?: string }) => {
          resolve(result ?? { success: false, error: "No response from server" });
        }
      );
    });
  },

  // Character System (NEW)
  setSelectedCharacterId: (id) => set({ selectedCharacterId: id }),
  setCharacterCustomizations: (customizations) => set({ characterCustomizations: customizations }),
  updateCharacterCustomization: (key, value) =>
    set((s) => ({
      characterCustomizations: {
        ...s.characterCustomizations,
        [key]: value,
      },
    })),
}));
