import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, FileCode2, GitCompare, ListChecks, MessageSquare, PanelRightClose, Send, Sparkles, Square, Trash2 } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { useUiStore, type CodingAgentTab } from "../../lib/uiStore";
import { DuckyMascot } from "../chat/DuckyMascot";
import { EventRow, MessageRow, StreamingRow } from "../chat/ChatMessageRow";
import { PartWriteBanner } from "./PartWriteBanner";
import { ToolSkillSelector } from "../chat/ToolSkillSelector";
import type { RenderedChatMessage } from "../chat/chatTypes";
import type { Plan } from "../chat/PlanExecutionPanel";
import { extractChangedFiles } from "../../lib/extractChangedFiles";
import { PanelEmpty } from "../ui/panel";
import { CodingPlanPanel } from "./CodingPlanPanel";
import { CodingChangesPanel } from "./CodingChangesPanel";
import { CodingTodoStrip, type CodingTodoItem } from "./CodingTodoStrip";

/**
 * Strip raw tool-call markers from an assistant message for the coding CHAT tab.
 * The agent's stored assistant text still contains the `[TOOL:...]` / `<|tool_call>`
 * markers it emitted before a tool ran; those belong in the Activity tab, not the
 * conversation. Tool calls end the turn, so cutting from the first marker keeps the
 * agent's narrative and drops the raw call. (Activity tab is untouched.)
 */
function stripToolMarkers(text: string): string {
  let out = text;
  for (const marker of ["[TOOL:", "<|tool_call>", "<tool_call>"]) {
    const idx = out.indexOf(marker);
    if (idx >= 0) out = out.slice(0, idx);
  }
  return out.trim();
}

/** A message body that is just a tool-result JSON payload (not something to read in chat). */
function looksLikeToolResultJson(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  return /"disposition"\s*:/.test(t) || (/"success"\s*:/.test(t) && /"toolName"\s*:/.test(t));
}


export function CodingAgentPanel({
  messages,
  isLoading,
  streamingContent,
  conversationId,
  project,
  activeFilePath,
  disabled,
  overridePlan,
  onExecutePlan,
  onOpenFile,
  hasMoreMessages,
  isLoadingMoreMessages,
  onLoadMoreMessages,
  onSend,
  onStop,
  onClearChat,
}: {
  messages: RenderedChatMessage[];
  isLoading: boolean;
  streamingContent: string;
  conversationId?: number;
  project: string;
  activeFilePath: string;
  disabled: boolean;
  overridePlan?: Plan | null;
  onExecutePlan?: (plan: Plan) => Promise<void>;
  onOpenFile?: (path: string) => void;
  hasMoreMessages?: boolean;
  isLoadingMoreMessages?: boolean;
  onLoadMoreMessages?: () => void;
  onSend: (text: string, options: { planMode: boolean; includeFile: string | null }) => void;
  onStop: () => void;
  onClearChat?: () => void;
}) {
  const { t } = useI18n();
  const { codingAgentTab, setCodingAgentTab, setCodingAgentOpen } = useUiStore();

  const [input, setInput] = useState("");
  const [planMode, setPlanMode] = useState(false);
  const [includeFile, setIncludeFile] = useState(true);
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const [showSelector, setShowSelector] = useState(false);
  const [selectorQuery, setSelectorQuery] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const activityBottomRef = useRef<HTMLDivElement>(null);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const pendingPrependHeightRef = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);

  // Conversation and tool noise are separated so a run with 40 tool calls does not
  // bury the two sentences the agent actually said.
  // Chat tab: real conversation only. Exclude activity ("event") and raw tool-result
  // ("tool") messages; for assistant messages strip the tool-call markers and instead
  // surface which files were changed as chips (opened in the editor on click). A message
  // that is only a tool call is kept solely for its file chip.
  const conversation = useMemo(() => {
    const out: Array<{ msg: RenderedChatMessage; changedFiles: string[] }> = [];
    for (const original of messages) {
      if (original.role === "event" || original.role === "tool") continue;
      if (original.role !== "assistant") {
        out.push({ msg: original, changedFiles: [] });
        continue;
      }
      if (looksLikeToolResultJson(original.content)) continue;
      const stripped = stripToolMarkers(original.content);
      const changedFiles = extractChangedFiles(original.content);
      if (stripped.length === 0 && changedFiles.length === 0) continue;
      out.push({ msg: { ...original, content: stripped }, changedFiles });
    }
    return out;
  }, [messages]);
  const events = useMemo(() => messages.filter((msg) => msg.role === "event"), [messages]);

  // The latest part-write decision (part_warning / part_healed / part_heal_error) emitted by
  // the CodingAgent at run end. The chat tab otherwise filters event messages out entirely,
  // so this is surfaced as a visible banner above the conversation.
  const partBannerMsg = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const msg = messages[index];
      if (!msg || msg.role !== "event") continue;
      const d = msg.eventData;
      if (d && (d.part_warning === true || d.part_healed === true || d.part_heal_error === true)) {
        return msg;
      }
    }
    return undefined;
  }, [messages]);

  // The agent's own checklist, taken from the LAST event that carried one. Each todo tool call
  // emits the full list, so the newest event is always the complete current state - no merging,
  // and no chance of showing a half-updated list.
  const todoItems = useMemo<CodingTodoItem[]>(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const candidate = messages[index];
      const items = candidate?.eventData?.["todo_items"];
      if (Array.isArray(items)) return items as CodingTodoItem[];
    }
    return [];
  }, [messages]);

  useEffect(() => {
    setExpandedEvents({});
  }, [conversationId]);

  useEffect(() => {
    if (codingAgentTab === "activity") activityBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent, codingAgentTab]);

  // Mirrors the /chat page's scroll-anchoring: prepending older messages must not yank
  // the viewport, and new messages should only auto-scroll to bottom when the user was
  // already near it (otherwise it fights with reading older history that was just loaded).
  useEffect(() => {
    if (codingAgentTab !== "chat") return;
    const viewport = chatViewportRef.current;
    if (!viewport) return;

    if (pendingPrependHeightRef.current !== null) {
      const previous = pendingPrependHeightRef.current;
      pendingPrependHeightRef.current = null;
      const delta = viewport.scrollHeight - previous;
      viewport.scrollTop = Math.max(0, viewport.scrollTop + delta);
      return;
    }

    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (stickToBottomRef.current || distanceToBottom < 300) {
      setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
    }
  }, [messages, streamingContent, codingAgentTab]);

  const handleChatScroll = () => {
    const viewport = chatViewportRef.current;
    if (!viewport) return;

    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    stickToBottomRef.current = distanceToBottom < 200;

    if (viewport.scrollTop > 120) return;
    if (!hasMoreMessages || isLoadingMoreMessages) return;

    pendingPrependHeightRef.current = viewport.scrollHeight;
    onLoadMoreMessages?.();
  };

  const autoGrow = (element: HTMLTextAreaElement | null) => {
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  };

  const handleInputChange = (value: string) => {
    setInput(value);
    autoGrow(textareaRef.current);
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

  const submit = () => {
    const text = input.trim();
    if (!text || disabled || isLoading) return;
    onSend(text, { planMode, includeFile: includeFile && activeFilePath ? activeFilePath : null });
    setInput("");
    setShowSelector(false);
    window.requestAnimationFrame(() => autoGrow(textareaRef.current));
  };

  const tabs: Array<{ key: CodingAgentTab; label: string; icon: typeof MessageSquare; count?: number }> = [
    { key: "chat", label: t("codingPage.tabChat"), icon: MessageSquare },
    { key: "plan", label: t("codingPage.tabPlan"), icon: ListChecks },
    { key: "changes", label: "Änderungen", icon: GitCompare },
    { key: "activity", label: t("codingPage.tabActivity"), icon: Activity, count: events.length },
  ];

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-1">
          {tabs.map(({ key, label, icon: Icon, count }) => (
            <button
              key={key}
              type="button"
              onClick={() => setCodingAgentTab(key)}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                codingAgentTab === key
                  ? "bg-primary/15 text-foreground ring-1 ring-primary/40"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
              {typeof count === "number" && count > 0 && (
                <span className="rounded-full bg-muted px-1 text-[10px]">{count}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <DuckyMascot
            working={isLoading}
            size={22}
            title={isLoading ? t("chat.duckyWorkingTitle") : t("chat.duckyIdleTitle")}
          />
          {onClearChat && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm(t("codingPage.clearChatConfirm"))) onClearChat();
              }}
              title={t("codingPage.clearChat")}
              disabled={isLoading || messages.length === 0}
              className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setCodingAgentOpen(false)}
            title={t("codingPage.hideAgentPanel")}
            className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {(codingAgentTab === "chat" || codingAgentTab === "activity") && <CodingTodoStrip items={todoItems} />}

      {codingAgentTab === "chat" && (
        <div
          ref={chatViewportRef}
          onScroll={handleChatScroll}
          className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2"
        >
          {isLoadingMoreMessages && (
            <div className="py-1 text-center text-[10px] text-muted-foreground">{t("chat.loadingOlder")}</div>
          )}
          {partBannerMsg && <PartWriteBanner msg={partBannerMsg} t={t} />}
          {conversation.length === 0 && !partBannerMsg && !isLoading ? (
            <PanelEmpty icon={<MessageSquare className="h-8 w-8" />} title={t("codingPage.noAgentOutput")} />
          ) : (
            conversation.map(({ msg, changedFiles }) => (
              <div key={msg.id} className="space-y-1">
                {msg.content.trim().length > 0 && <MessageRow msg={msg} compactMode dense t={t} />}
                {changedFiles.length > 0 && (
                  <div className="flex flex-wrap gap-1 pl-1">
                    {changedFiles.map((path) => (
                      <button
                        key={path}
                        type="button"
                        onClick={() => onOpenFile?.(path)}
                        className="chip hover:border-primary/50 hover:text-primary"
                        title={`${path} im Editor oeffnen`}
                      >
                        <FileCode2 className="h-3 w-3 shrink-0" />
                        <span className="truncate">{path.split("/").pop()}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
          {isLoading && <StreamingRow compactMode streamingContent={streamingContent} t={t} />}
          <div ref={chatBottomRef} />
        </div>
      )}

      {codingAgentTab === "changes" && (
        <CodingChangesPanel project={project} onOpenFile={onOpenFile} refreshKey={isLoading ? 0 : messages.length} />
      )}

      {codingAgentTab === "plan" && (
        <CodingPlanPanel
          messages={messages}
          conversationId={conversationId}
          isLoading={isLoading}
          overridePlan={overridePlan}
          onExecutePlan={onExecutePlan}
          onRefine={(prompt) => {
            setCodingAgentTab("chat");
            setPlanMode(true);
            setInput(prompt);
            window.requestAnimationFrame(() => {
              autoGrow(textareaRef.current);
              textareaRef.current?.focus();
            });
          }}
        />
      )}

      {codingAgentTab === "activity" && (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
          {events.length === 0 ? (
            <PanelEmpty icon={<Activity className="h-8 w-8" />} title={t("codingPage.noActivity")} />
          ) : (
            events.map((msg) => (
              <EventRow
                key={msg.id}
                msg={msg}
                t={t}
                expanded={expandedEvents[msg.id] ?? false}
                onToggle={(isOpen) => setExpandedEvents((prev) => ({ ...prev, [msg.id]: isOpen }))}
              />
            ))
          )}
          <div ref={activityBottomRef} />
        </div>
      )}

      {/* Composer stays mounted on every tab - the plan tab needs it for "Verfeinern". */}
      <div className="shrink-0 space-y-1.5 border-t border-border p-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => setPlanMode(false)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                !planMode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t("codingPage.modeAgent")}
            </button>
            <button
              type="button"
              onClick={() => setPlanMode(true)}
              title={t("codingPage.modePlanHint")}
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                planMode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Sparkles className="h-3 w-3" />
              {t("codingPage.modePlan")}
            </button>
          </div>

          {activeFilePath && (
            <button
              type="button"
              onClick={() => setIncludeFile((prev) => !prev)}
              title={t("codingPage.contextFileHint")}
              className={`chip max-w-[60%] transition-colors ${
                includeFile ? "border-primary/50 bg-primary/10 text-primary" : ""
              }`}
            >
              <FileCode2 className="h-3 w-3 shrink-0" />
              <span className="truncate">{activeFilePath.split("/").pop()}</span>
            </button>
          )}
        </div>

        <div className="relative">
          <textarea
            ref={textareaRef}
            rows={2}
            className="input max-h-[180px] w-full resize-none py-1.5 text-sm"
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !showSelector) {
                e.preventDefault();
                submit();
              }
            }}
            disabled={disabled}
            placeholder={t("codingPage.chatPlaceholder")}
          />
          {showSelector && (
            <ToolSkillSelector
              query={selectorQuery}
              conversationId={conversationId}
              onInsertSkill={(slug) => {
                setInput(`/${slug} `);
                setShowSelector(false);
                textareaRef.current?.focus();
              }}
              onToolExecuted={() => {
                setInput("");
                setShowSelector(false);
              }}
              onClose={() => setShowSelector(false)}
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[10px] text-muted-foreground">{t("codingPage.sendHint")}</span>
          {isLoading ? (
            <button
              type="button"
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-foreground px-3 py-1 text-xs text-background transition hover:opacity-80"
              onClick={onStop}
              title={t("chat.stop")}
            >
              <Square className="h-3 w-3 fill-current" />
              {t("chat.stop")}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary shrink-0 px-3 py-1 text-xs"
              onClick={submit}
              disabled={!input.trim() || disabled}
            >
              <Send className="mr-1 inline h-3.5 w-3.5" />
              {t("codingPage.send")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
