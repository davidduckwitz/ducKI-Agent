import { create } from "zustand";
import { io, type Socket } from "socket.io-client";
import { translations, type Language, type TranslationTree } from "./translations";
import type { AgentEventType } from "../components/chat/chatTypes";

const LANGUAGE_STORAGE_KEY = "ducki.language";

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
}

interface AppState {
  // Agent
  agentStatus: "idle" | "running" | "paused" | "error" | "stopped";

  // Chat
  messages: ChatMessage[];
  conversationId: number | undefined;
  awaitingNewConversation: boolean;
  isLoading: boolean;
  streamingContent: string;
  globalRunningAgents: number;

  // Socket
  socket: Socket | null;
  connected: boolean;

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

  // Actions
  initSocket: () => void;
  disconnectSocket: () => void;
  sendMessage: (
    content: string,
    attachments?: ChatAttachment[],
    agentMode?: AgentMode,
    /** What to show in the chat when `content` carries extra machine-facing context. */
    displayContent?: string
  ) => void;
  stopMessage: () => void;
  clearChat: () => void;
  setConversationId: (id: number | undefined) => void;
  setMessages: (messages: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  setAgentStatus: (status: AppState["agentStatus"]) => void;
  setGlobalRunningAgents: (count: number) => void;
  setSetupModalOpen: (open: boolean) => void;
  setBrowserPreviewModal: (show: boolean, preview?: BrowserPreviewState["currentPreview"]) => void;
  setAnimationStyle: (style: "matrix" | "neon" | "minimal") => void;

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
  removeBrowserSession: (tabId: string) => void;
  setShowToolDock: (show: boolean) => void;
}

export type AgentMode = "full" | "plan";

export const useAppStore = create<AppState>((set, get) => ({
  agentStatus: "idle",
  messages: [],
  conversationId: undefined,
  awaitingNewConversation: false,
  isLoading: false,
  streamingContent: "",
  globalRunningAgents: 0,
  socket: null,
  connected: false,
  setupModalOpen: false,
  animationStyle: "matrix",
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

  initSocket: () => {
    const socketUrl = import.meta.env.DEV
      ? (import.meta.env.VITE_SOCKET_URL ?? "http://127.0.0.1:3001")
      : undefined;
    const socket = io(socketUrl, {
      path: "/socket.io",
      transports: ["websocket"],
    });

    socket.on("connect", () => {
      set({ connected: true });
      socket.emit("agent:status");
    });

    socket.on("disconnect", () => {
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
        messages: s.isLoading ? [...s.messages, disconnectMsg] : s.messages,
      }));
    });

    socket.on("connect_error", () => {
      set((s) => ({
        connected: false,
        isLoading: false,
        streamingContent: "",
      }));
    });

    // A run's events belong to the currently displayed chat only if their conversationId
    // matches, or the chat is a brand-new one still waiting to learn its id from the server
    // (and the user hasn't switched to a different chat in the meantime).
    const belongsToActiveConversation = (eventConversationId?: number): boolean => {
      const s = get();
      if (s.conversationId === eventConversationId) return true;
      return s.awaitingNewConversation && s.conversationId === undefined;
    };

    socket.on("chat:conversation", (data: { conversationId: number }) => {
      set((s) => {
        if (!s.awaitingNewConversation) return {};
        return { conversationId: data.conversationId, awaitingNewConversation: false };
      });
    });

    socket.on("chat:start", (data: { conversationId?: number }) => {
      if (!belongsToActiveConversation(data.conversationId)) return;
      set({ isLoading: true, streamingContent: "" });
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
      set((s) => ({
        messages: [...s.messages, msg],
      }));
    });

    socket.on("chat:chunk", (data: { content: string; conversationId?: number }) => {
      if (!belongsToActiveConversation(data.conversationId)) return;
      set((s) => ({ streamingContent: s.streamingContent + data.content }));
    });

    socket.on("chat:complete", (data: { response: string; conversationId?: number }) => {
      if (!belongsToActiveConversation(data.conversationId)) return;
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: data.response,
        timestamp: new Date().toISOString(),
      };
      set((s) => ({
        messages: [...s.messages, msg],
        isLoading: false,
        streamingContent: "",
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
        messages: [...s.messages, msg],
        isLoading: false,
        streamingContent: "",
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
        messages: [...s.messages, msg],
        isLoading: false,
        streamingContent: "",
      }));
    });

    socket.on("agent:status", (data: { status: AppState["agentStatus"] }) => {
      set({ agentStatus: data.status });
    });

    socket.on("agent:metrics", (data: { runningCount?: number }) => {
      set({ globalRunningAgents: Number(data?.runningCount ?? 0) });
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
    });

    // Tool call tracking
    socket.on("tool:call_started", (data: { timestamp: string; conversationId?: number; data?: Record<string, unknown> }) => {
      if (!belongsToActiveConversation(data.conversationId)) return;
      const toolData = data.data as { count?: number; tools?: string[]; summaries?: string[] } | undefined;
      const callId = crypto.randomUUID();
      const toolCall: ToolCallRecord = {
        id: callId,
        toolName: toolData?.tools?.[0] ?? "unknown",
        timestamp: data.timestamp,
        status: "executing",
        input: toolData,
      };
      get().addToolCall(toolCall);
    });

    set({ socket });
  },

  disconnectSocket: () => {
    get().socket?.disconnect();
    set({ socket: null, connected: false });
  },

  sendMessage: (content: string, attachments?: ChatAttachment[], agentMode?: AgentMode, displayContent?: string) => {
    const { socket, conversationId, isLoading } = get();
    if (!socket || !content.trim() || isLoading) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      // Callers that wrap the prompt in machine-facing context (the coding workspace
      // prepends a [CODING_CONTEXT] block) pass what the user actually typed here, so the
      // chat shows their message instead of the scaffolding around it.
      content: displayContent ?? content,
      timestamp: new Date().toISOString(),
      metadata: attachments && attachments.length > 0 ? { attachments } : undefined,
    };

    // Set isLoading synchronously (not waiting for the server's "chat:start" ack) so the
    // send button/Enter key are disabled immediately. Without this, a second message fired
    // before the round-trip completes would still see conversationId as undefined and cause
    // the server to spin up a brand-new conversation per message instead of reusing one.
    set((s) => ({
      messages: [...s.messages, userMsg],
      isLoading: true,
      streamingContent: "",
      // Only a brand-new chat (no conversationId yet) needs to wait for the server to
      // assign one; if the user switches chats before it arrives, this flag lets the
      // chat:conversation handler recognize the id is stale and ignore it.
      awaitingNewConversation: conversationId === undefined,
    }));
    socket.emit("chat:message", { message: content, conversationId, attachments, agentMode });
  },

  stopMessage: () => {
    const { socket, conversationId } = get();
    if (!socket) return;
    socket.emit("chat:stop", { conversationId });
  },

  clearChat: () => set({ messages: [] }),
  setConversationId: (id) => set({ conversationId: id, messages: [], awaitingNewConversation: false }),
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
