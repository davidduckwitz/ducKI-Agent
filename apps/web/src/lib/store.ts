import { create } from "zustand";
import { io, type Socket } from "socket.io-client";
import { translations, type Language, type TranslationTree } from "./translations";

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

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "event" | "tool";
  content: string;
  timestamp: string;
  eventType?: "plan" | "iteration" | "tool_call" | "tool_result" | "reasoning" | "decision" | "guardrail";
  eventData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface ChatEvent {
  type: "plan" | "iteration" | "tool_call" | "tool_result" | "reasoning" | "decision" | "guardrail";
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

interface AppState {
  // Agent
  agentStatus: "idle" | "running" | "paused" | "error" | "stopped";
  
  // Chat
  messages: ChatMessage[];
  conversationId: number | undefined;
  isLoading: boolean;
  streamingContent: string;
  globalRunningAgents: number;
  
  // Socket
  socket: Socket | null;
  connected: boolean;

  // UI
  setupModalOpen: boolean;
  
  // Actions
  initSocket: () => void;
  disconnectSocket: () => void;
  sendMessage: (content: string) => void;
  stopMessage: () => void;
  clearChat: () => void;
  setConversationId: (id: number | undefined) => void;
  setMessages: (messages: ChatMessage[]) => void;
  setAgentStatus: (status: AppState["agentStatus"]) => void;
  setGlobalRunningAgents: (count: number) => void;
  setSetupModalOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  agentStatus: "idle",
  messages: [],
  conversationId: undefined,
  isLoading: false,
  streamingContent: "",
  globalRunningAgents: 0,
  socket: null,
  connected: false,
  setupModalOpen: false,

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

    socket.on("connect_error", (error: Error) => {
      const errorMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `${t("chat.socketErrorPrefix")} ${error.message}`,
        timestamp: new Date().toISOString(),
      };
      set((s) => ({
        connected: false,
        isLoading: false,
        streamingContent: "",
        messages: [...s.messages, errorMsg],
      }));
    });

    socket.on("chat:conversation", (data: { conversationId: number }) => {
      set({ conversationId: data.conversationId });
    });

    socket.on("chat:start", () => {
      set({ isLoading: true, streamingContent: "" });
    });

    socket.on("chat:event", (event: ChatEvent) => {
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

    socket.on("chat:chunk", (data: { content: string }) => {
      set((s) => ({ streamingContent: s.streamingContent + data.content }));
    });

    socket.on("chat:complete", (data: { response: string }) => {
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

    socket.on("chat:stopped", () => {
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

    socket.on("chat:error", (data: { error: string }) => {
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

    set({ socket });
  },

  disconnectSocket: () => {
    get().socket?.disconnect();
    set({ socket: null, connected: false });
  },

  sendMessage: (content: string) => {
    const { socket, conversationId } = get();
    if (!socket || !content.trim()) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    };

    set((s) => ({ messages: [...s.messages, userMsg] }));
    socket.emit("chat:message", { message: content, conversationId });
  },

  stopMessage: () => {
    const { socket } = get();
    if (!socket) return;
    socket.emit("chat:stop");
  },

  clearChat: () => set({ messages: [], conversationId: undefined }),
  setConversationId: (id) => set({ conversationId: id }),
  setMessages: (messages) => set({ messages }),
  setAgentStatus: (status) => set({ agentStatus: status }),
  setGlobalRunningAgents: (count) => set({ globalRunningAgents: Math.max(0, count) }),
  setSetupModalOpen: (open) => set({ setupModalOpen: open }),
}));
