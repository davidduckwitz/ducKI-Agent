import { useState, useRef, useEffect } from "react";
import { Send, Trash2, Bot, User, Wrench, BrainCircuit, GitBranch, Activity, Paperclip, Square, Image as ImageIcon, X, PanelLeft } from "lucide-react";
import { useAppStore } from "../../lib/store";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

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

const eventIcon = (eventType?: "plan" | "iteration" | "tool_call" | "tool_result" | "reasoning" | "decision" | "guardrail") => {
  if (eventType === "plan") return <GitBranch className="w-4 h-4 text-indigo-300" />;
  if (eventType === "tool_call" || eventType === "tool_result") return <Wrench className="w-4 h-4 text-amber-300" />;
  if (eventType === "iteration") return <Activity className="w-4 h-4 text-blue-300" />;
  if (eventType === "decision" || eventType === "guardrail") return <BrainCircuit className="w-4 h-4 text-emerald-300" />;
  return <BrainCircuit className="w-4 h-4 text-purple-300" />;
};

const eventLabel = (
  t: (key: string) => string,
  eventType?: "plan" | "iteration" | "tool_call" | "tool_result" | "reasoning" | "decision" | "guardrail"
) => {
  if (eventType === "plan") return t("chat.eventPlan");
  if (eventType === "tool_call") return t("chat.eventToolCall");
  if (eventType === "tool_result") return t("chat.eventToolResult");
  if (eventType === "iteration") return t("chat.eventIteration");
  if (eventType === "decision") return t("chat.eventDecision");
  if (eventType === "guardrail") return t("chat.eventGuardrail");
  return t("chat.eventReasoning");
};

export function ChatContainer() {
  const { t } = useI18n();
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
  } = useAppStore();
  const [input, setInput] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [analyzeImages, setAnalyzeImages] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showConversationList, setShowConversationList] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const [searchParams, setSearchParams] = useSearchParams();
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const defaultExpandedForType = (
    eventType?: "plan" | "iteration" | "tool_call" | "tool_result" | "reasoning" | "decision" | "guardrail"
  ) => eventType === "tool_call" || eventType === "tool_result" || eventType === "guardrail";

  const conversationsQuery = useQuery({
    queryKey: ["chat", "conversations"],
    queryFn: () => api.chat.listConversations() as Promise<ConversationItem[]>,
  });

  const selectedConversationMessages = useQuery({
    queryKey: ["chat", "messages", conversationId],
    queryFn: () => api.chat.getMessages(conversationId ?? 0) as Promise<PersistedMessage[]>,
    enabled: Boolean(conversationId),
  });

  useEffect(() => {
    const fromQuery = Number(searchParams.get("conversationId") ?? "");
    if (Number.isFinite(fromQuery) && fromQuery > 0 && fromQuery !== conversationId) {
      setConversationId(fromQuery);
      const next = new URLSearchParams(searchParams);
      next.delete("conversationId");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, conversationId, setConversationId, setSearchParams]);

  useEffect(() => {
    if (!conversationId) return;
    const persisted = selectedConversationMessages.data;
    if (!persisted) return;

    const mapPersistedMessage = (msg: PersistedMessage) => {
      const metadata = parseMessageMetadata(msg.metadata);

      if (msg.role === "event") {
        let eventType: "plan" | "iteration" | "tool_call" | "tool_result" | "reasoning" | "decision" | "guardrail" | undefined;
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
              type === "guardrail"
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

    setMessages(
      persisted.map(mapPersistedMessage)
    );
  }, [conversationId, selectedConversationMessages.data, setMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

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
    if (attachedFiles.length > 0) {
      setUploading(true);
      try {
        const uploadedPaths: string[] = [];
        for (const file of attachedFiles) {
          const contentBase64 = await toBase64(file);
          const uploaded = await api.shared.uploadFile({
            fileName: file.name,
            contentBase64,
            folder: "chat-uploads",
          });
          uploadedPaths.push(uploaded.path);
        }

        const imagePaths = uploadedPaths.filter((p) => /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(p));
        const list = uploadedPaths.map((p) => `- shared-workspace/${p}`).join("\n");
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

    sendMessage(finalInput);
    setInput("");
    setAttachedFiles([]);
    setAnalyzeImages(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <aside className={`${showConversationList ? "block" : "hidden"} lg:block ${compactMode ? "lg:w-72" : "lg:w-80"} w-full border-b lg:border-b-0 lg:border-r border-gray-800 p-3 overflow-y-auto space-y-2 max-h-[42vh] lg:max-h-none shrink-0`}>
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

        {(conversationsQuery.data ?? []).map((conv) => (
          <button
            key={conv.id}
            onClick={() => {
              setConversationId(conv.id);
            }}
            className={`w-full text-left rounded-lg border px-3 py-2 transition ${
              conversationId === conv.id
                ? "border-blue-500 bg-blue-500/10"
                : "border-gray-800 bg-gray-900 hover:border-gray-700"
            }`}
          >
            <div className="text-sm font-medium truncate">{conv.name}</div>
            <div className="text-xs text-gray-400 mt-1">
              {new Date(conv.updatedAt).toLocaleString()}
            </div>
          </button>
        ))}

        {(conversationsQuery.data ?? []).length === 0 && (
          <div className="text-xs text-gray-500 py-4">{t("chat.noSaved")}</div>
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
        </div>
        <div className="flex items-center gap-2">
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
          <button onClick={clearChat} className="btn-secondary flex items-center gap-2 text-sm">
            <Trash2 className="w-4 h-4" />
            {t("chat.clear")}
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className={`flex-1 min-h-0 overflow-y-auto ${compactMode ? "px-2 py-2 sm:px-3" : "px-3 py-4 sm:px-4"}`}>
        <div className={`mx-auto w-full ${compactMode ? "max-w-3xl space-y-2" : "max-w-4xl space-y-4"}`}>
        {messages.length === 0 && (
          <div className="text-center text-gray-500 mt-20">
            <Bot className="w-12 h-12 mx-auto mb-4 text-gray-700" />
            <p>{t("chat.startConversation")}</p>
          </div>
        )}

        {messages.map((msg) => (
          msg.role === "event" ? (
            <details
              key={msg.id}
              open={expandedEvents[msg.id] ?? defaultExpandedForType(msg.eventType)}
              onToggle={(e) => {
                const isOpen = (e.currentTarget as HTMLDetailsElement).open;
                setExpandedEvents((prev) => ({ ...prev, [msg.id]: isOpen }));
              }}
              className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-100"
            >
              <summary className="list-none cursor-pointer select-none flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 min-w-0">
                  {eventIcon(msg.eventType)}
                  <span className="font-medium whitespace-nowrap">{eventLabel(t, msg.eventType)}</span>
                  <span className="text-indigo-200/80 truncate">{msg.content}</span>
                </span>
                <span className="text-[10px] text-indigo-200/70 whitespace-nowrap">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </span>
              </summary>
              <div className="mt-2 pl-6 space-y-2">
                <div className="text-indigo-100 whitespace-pre-wrap">{msg.content}</div>
                {msg.eventData && (
                  <pre className="rounded border border-indigo-400/20 bg-black/20 p-2 text-[11px] whitespace-pre-wrap overflow-x-auto">
                    {JSON.stringify(msg.eventData, null, 2)}
                  </pre>
                )}
              </div>
            </details>
          ) : (
            <div
              key={msg.id}
              className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                msg.role === "user" ? "bg-blue-600" : "bg-gray-700"
              }`}>
                {msg.role === "user" ? (
                  <User className="w-4 h-4" />
                ) : (
                  <Bot className="w-4 h-4" />
                )}
              </div>
              <div
                className={`${compactMode ? "max-w-[94%] sm:max-w-[82%] lg:max-w-[74%] rounded-lg px-3 py-2 text-[13px]" : "max-w-[90%] sm:max-w-[80%] lg:max-w-[72%] rounded-xl px-4 py-3 text-sm"} whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-800 text-gray-100"
                }`}
              >
                {(() => {
                  const metadata = msg.metadata as
                    | {
                        portal?: string;
                        mode?: string;
                        agentEmoji?: string;
                        attachments?: Array<Record<string, unknown>>;
                        voice?: { transcript?: string };
                      }
                    | undefined;

                  if (!metadata) return null;

                  return (
                  <div className="mb-2 flex flex-wrap gap-1 text-[10px]">
                    {typeof metadata.portal === "string" && (
                      <span className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5 uppercase tracking-wide">
                        {metadata.portal}
                      </span>
                    )}
                    {typeof metadata.mode === "string" && (
                      <span className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5 capitalize">
                        {metadata.mode}
                      </span>
                    )}
                    {typeof metadata.agentEmoji === "string" && (
                      <span className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5">
                        {metadata.agentEmoji}
                      </span>
                    )}
                  </div>
                  );
                })()}
                {msg.content}
                {(() => {
                  const metadata = msg.metadata as
                    | {
                        attachments?: Array<Record<string, unknown>>;
                      }
                    | undefined;

                  if (!metadata?.attachments || metadata.attachments.length === 0) return null;

                  return (
                  <div className="mt-2 space-y-1 text-[11px] opacity-90">
                    {metadata.attachments.map((attachment, index) => (
                      <div key={index} className="rounded border border-white/10 bg-black/20 px-2 py-1">
                        <div className="font-medium">{String(attachment.name ?? `${t("chat.fileLabel")} ${index + 1}`)}</div>
                        <div className="opacity-80 break-all">
                          {String(attachment.path ?? attachment.url ?? attachment.mimeType ?? t("chat.noAttachmentLabel"))}
                        </div>
                      </div>
                    ))}
                  </div>
                  );
                })()}
                {(() => {
                  const metadata = msg.metadata as
                    | {
                        voice?: { transcript?: string };
                      }
                    | undefined;

                  if (!metadata?.voice) return null;

                  return (
                  <div className="mt-2 rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] opacity-90">
                    <div className="font-medium">{t("chat.voiceInput")}</div>
                    <div className="opacity-80">{String(metadata.voice.transcript ?? "")}</div>
                  </div>
                  );
                })()}
              </div>
            </div>
          )
        ))}

        {/* Streaming */}
        {isLoading && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4" />
            </div>
            <div className={`${compactMode ? "max-w-[94%] sm:max-w-[82%] lg:max-w-[74%] rounded-lg px-3 py-2 text-[13px]" : "max-w-[90%] sm:max-w-[80%] lg:max-w-[72%] rounded-xl px-4 py-3 text-sm"} bg-gray-800 text-gray-100 whitespace-pre-wrap`}>
              {streamingContent || (
                <span className="flex gap-1">
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </span>
              )}
            </div>
          </div>
        )}

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

        <div className="flex gap-2">
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
            onChange={(e) => setInput(e.target.value)}
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
    </div>
  );
}
