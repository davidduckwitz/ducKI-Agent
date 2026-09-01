import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, CheckCircle2, ChevronDown, Clock, FileCode2, GitCompare, Gauge, ListChecks, MessageSquare, PanelRightClose, Send, Sparkles, Square, Trash2, Zap } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { useUiStore, type CodingAgentTab } from "../../lib/uiStore";
import { useAppStore } from "../../lib/store";
import { useServerQuery } from "../../lib/useServerQuery";
import { api } from "../../lib/api";
import { ProviderModelSelector } from "../chat/ProviderModelSelector";
import { DuckyMascot } from "../chat/DuckyMascot";
import { EventRow, MessageRow, StreamingRow } from "../chat/ChatMessageRow";
import { eventIcon, eventLabel, eventTone } from "../chat/eventMeta";
import { PartWriteBanner } from "./PartWriteBanner";
import { ToolSkillSelector } from "../chat/ToolSkillSelector";
import type { RenderedChatMessage } from "../chat/chatTypes";
import type { Plan } from "../chat/PlanExecutionPanel";
import { extractChangedFiles, stripToolMarkers } from "../../lib/extractChangedFiles";
import { PanelEmpty } from "../ui/panel";
import { CodingPlanPanel } from "./CodingPlanPanel";
import { CodingDonePanel } from "./CodingDonePanel";
import { CodingChangesPanel } from "./CodingChangesPanel";
import { CodingTodoStrip, type CodingTodoItem } from "./CodingTodoStrip";
import { CodingAttemptTimeline } from "./CodingAttemptTimeline";

/**
 * Strip raw tool-call markers from an assistant message for the coding CHAT tab.
 * The agent's stored assistant text still contains the `[TOOL:...]` / `<|tool_call>`
 * markers it emitted before a tool ran; those belong in the Activity tab, not the
 * conversation. Tool calls end the turn, so cutting from the first marker keeps the
 * agent's narrative and drops the raw call. (Activity tab is untouched.)
 */
/** Compact "12.3k" style formatting for a token count - matches how the rest of the chat UI
 *  abbreviates large numbers (see the ⚡ total-tokens chip in ChatComposer). */
function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** A message body that is just a tool-result JSON payload (not something to read in chat). */
function looksLikeToolResultJson(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  return /"disposition"\s*:/.test(t) || (/"success"\s*:/.test(t) && /"toolName"\s*:/.test(t));
}

/**
 * Recovers the actual goal text from a user message that is CodingAgent's full internal
 * prompt (path rules, phase contract, plan, ...) instead of what was typed. Conversations
 * created before the backend started persisting a separate display string (Agent.run's
 * displayContent option) still have this scaffold stored as their "user" message - this is
 * a read-side fallback for those, not needed for anything persisted after the fix.
 */
function stripCodingScaffold(text: string): string {
  const match = /^Goal:\s*([\s\S]*?)\n\nProject root:/.exec(text);
  return match?.[1]?.trim() || text;
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
  const { codingAgentTab, setCodingAgentTab, setCodingAgentOpen, setCodingChangesSelected } = useUiStore();
  const openCheckpointDiff = (sha: string) => {
    setCodingChangesSelected(project, sha);
    setCodingAgentTab("changes");
  };
  // Same global selection the regular chat's LLM selector uses (ChatComposer) - unset
  // means "use the system default provider/model" for this coding run too.
  const chatProvider = useAppStore((s) => s.chatProvider);
  const chatModel = useAppStore((s) => s.chatModel);
  const setChatProvider = useAppStore((s) => s.setChatProvider);
  const setChatModel = useAppStore((s) => s.setChatModel);

  const [input, setInput] = useState("");
  const [planMode, setPlanMode] = useState(false);
  const [includeFile, setIncludeFile] = useState(true);
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const [showSelector, setShowSelector] = useState(false);
  const [selectorQuery, setSelectorQuery] = useState("");
  const [showLLMSelector, setShowLLMSelector] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const activityBottomRef = useRef<HTMLDivElement>(null);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const pendingPrependHeightRef = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);

  // Context-window usage: the cost governor's running total ("Cost usage updated" events carry
  // eventData.totalTokens as a CUMULATIVE total across every call so far, not a per-call delta),
  // plus the context window of whichever model is actually in effect - the explicit override if
  // one is set, else the system default (from /provider-models/active, so this works even when
  // the user never touched the LLM selector). Takes the LATEST such event, not a sum across all
  // of them - summing cumulative totals compounds them into a wildly inflated number.
  const totalTokens = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const tokens = messages[i]?.eventData?.["totalTokens"] as number | undefined;
      if (typeof tokens === "number") return tokens;
    }
    return 0;
  }, [messages]);
  const activeProviderQuery = useServerQuery({
    queryKey: ["provider-models", "active"],
    queryFn: () => api.providerModels.active(),
    // The model catalog doesn't change mid-run - without this, useServerQuery's adaptive
    // polling (tied to isLoading) re-hit LM Studio's /v1/models every 1.5s for the entire
    // duration of every run. It's still refetched on mount and whenever chatProvider/model
    // change (new queryKey) or the user reopens the selector - just not continuously.
    volatility: "idle",
  });
  const overrideModelsQuery = useServerQuery({
    queryKey: ["provider-models", chatProvider],
    queryFn: () => api.providerModels.getModels(chatProvider!),
    enabled: Boolean(chatProvider),
    volatility: "idle",
  });
  const effectiveModelId = chatModel || activeProviderQuery.data?.activeModel;
  const contextLength = chatProvider
    ? overrideModelsQuery.data?.models.find((m) => m.id === effectiveModelId)?.contextLength
    : activeProviderQuery.data?.models.find((m) => m.id === effectiveModelId)?.contextLength;

  // Run timer: counts up while a run is in flight, frozen at the last duration once it ends -
  // so "how long did that take" stays visible instead of vanishing the instant the run finishes.
  const runStartRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!isLoading) {
      runStartRef.current = null;
      return;
    }
    runStartRef.current = Date.now();
    setElapsedMs(0);
    const interval = window.setInterval(() => {
      if (runStartRef.current) setElapsedMs(Date.now() - runStartRef.current);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isLoading]);

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
      if (original.role === "user") {
        out.push({ msg: { ...original, content: stripCodingScaffold(original.content) }, changedFiles: [] });
        continue;
      }
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
  // Activity tab events: exclude checklist-update events whose todo_items are already shown
  // in the pinned CodingTodoStrip above (no other information worth an inline bubble), and
  // "assistant_text" rows - a persisted mirror of the model's already-cleaned reply meant to be
  // rendered as a chat bubble elsewhere (see Agent.emitDisplayText), not as a generic Activity
  // event. Without this it fell through eventLabel's default case and showed up mislabeled as
  // "Reasoning".
  const events = useMemo(
    () =>
      messages.filter(
        (msg) =>
          msg.role === "event" &&
          msg.eventType !== "assistant_text" &&
          !Array.isArray(msg.eventData?.["todo_items"])
      ),
    [messages]
  );

  // Groups activity events per iteration instead of showing every tool-call/result/decision
  // row as its own separate bubble forever - a busy iteration (e.g. two todo:update calls,
  // each with its own Plan-sync + checklist pair) used to leave 8+ stacked bubbles behind for
  // one logical step. An "iteration" event marks the start of a new one, so everything up to
  // the next such event belongs to the same group.
  const eventGroups = useMemo(() => {
    const groups: Array<{ key: string; events: RenderedChatMessage[] }> = [];
    for (const msg of events) {
      if (msg.eventType === "iteration" || groups.length === 0) {
        groups.push({ key: msg.id, events: [msg] });
      } else {
        groups[groups.length - 1]!.events.push(msg);
      }
    }
    // "Analysiere Ergebnisse..." (internal_instruction, kind tool_analysis/screenshot_analysis)
    // is a status note ahead of the model's next turn - worth seeing when something needs
    // investigating, pure noise when every tool call this iteration already succeeded (the
    // overwhelming common case, and previously a "Hinweis" row after nearly EVERY tool call).
    for (const group of groups) {
      const hasFailure = group.events.some(
        (m) => m.eventType === "tool_result" && m.eventData?.["success"] === false
      );
      if (!hasFailure) {
        group.events = group.events.filter(
          (m) =>
            !(
              m.eventType === "internal_instruction" &&
              (m.eventData?.["kind"] === "tool_analysis" || m.eventData?.["kind"] === "screenshot_analysis")
            )
        );
      }
    }
    return groups.filter((group) => group.events.length > 0);
  }, [events]);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

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
    // "smooth" here caused the back-and-forth scroll jitter you get when several activity
    // events land close together (e.g. two todo:update calls each firing their own Plan-sync +
    // checklist event pair, see coding-agent.ts's batched todo:update) - each new event
    // restarted a fresh smooth-scroll animation before the previous one finished, and the
    // resulting stack of overlapping animations visibly fought each other. An instant jump
    // has no animation to interrupt, so rapid-fire updates just land at the bottom immediately.
    if (codingAgentTab === "activity") activityBottomRef.current?.scrollIntoView({ behavior: "auto" });
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
    { key: "done", label: t("codingPage.tabDone"), icon: CheckCircle2 },
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

      {(codingAgentTab === "chat" || codingAgentTab === "activity" || codingAgentTab === "plan") && (
        <>
          <CodingAttemptTimeline events={events} />
          <CodingTodoStrip items={todoItems} />
        </>
      )}

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
        />
      )}

      {codingAgentTab === "activity" && (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
          {events.length === 0 ? (
            <PanelEmpty icon={<Activity className="h-8 w-8" />} title={t("codingPage.noActivity")} />
          ) : (
            eventGroups.map((group, groupIndex) => {
              const isLatest = groupIndex === eventGroups.length - 1;
              // Auto-expanded while it's the run's current (last) group so progress stays
              // visible live; auto-collapses once a newer group starts, unless the user
              // explicitly pinned it open/closed themselves.
              const isOpen = collapsedGroups[group.key] ?? isLatest;
              const last = group.events[group.events.length - 1]!;
              const toolName = typeof last.eventData?.["toolName"] === "string" ? (last.eventData["toolName"] as string) : undefined;
              // A plain toggleable div, not a nested <details> - EventRow below renders its OWN
              // <details> per event, and native "toggle" events (unlike click) do not bubble in
              // the DOM at all. React's synthetic handling for non-bubbling events has known
              // nested-<details> bugs where toggling the INNER one also fires the OUTER
              // onToggle, snapping the whole group open/closed when only one row was clicked -
              // exactly the "closing/opening breaks the UI" symptom. A button-driven boolean
              // sidesteps that class of bug entirely.
              return (
                <div
                  key={group.key}
                  className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${eventTone(last.eventType, last.eventData)}`}
                >
                  <button
                    type="button"
                    onClick={() => setCollapsedGroups((prev) => ({ ...prev, [group.key]: !isOpen }))}
                    className="flex w-full list-none cursor-pointer select-none items-baseline justify-between gap-2 text-left"
                  >
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <ChevronDown className={`h-3 w-3 shrink-0 self-center transition-transform ${isOpen ? "rotate-180" : ""}`} />
                      <span className="self-center shrink-0">{eventIcon(last.eventType, last.eventData)}</span>
                      <span className="font-medium whitespace-nowrap opacity-90">{toolName ?? eventLabel(t, last.eventType)}</span>
                      <span className="truncate opacity-80">{last.content}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-[10px] opacity-60 whitespace-nowrap">
                      {group.events.length > 1 && (
                        <span className="rounded bg-black/20 px-1.5">{group.events.length}</span>
                      )}
                      <span>{new Date(last.timestamp).toLocaleTimeString()}</span>
                    </span>
                  </button>
                  {isOpen && (
                    <div className="mt-1.5 space-y-1.5 border-t border-white/10 pt-1.5">
                      {group.events.map((msg) => (
                        <EventRow
                          key={msg.id}
                          msg={msg}
                          t={t}
                          expanded={expandedEvents[msg.id] ?? false}
                          onToggle={(open) => setExpandedEvents((prev) => ({ ...prev, [msg.id]: open }))}
                          onOpenCheckpoint={openCheckpointDiff}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
          <div ref={activityBottomRef} />
        </div>
      )}

      {codingAgentTab === "done" && (
        <CodingDonePanel conversationId={conversationId} isLoading={isLoading} />
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

          <button
            type="button"
            onClick={() => setShowLLMSelector((prev) => !prev)}
            title={t("codingPage.llmSelectorHint")}
            className={`chip max-w-[60%] transition-colors ${
              showLLMSelector || chatProvider || chatModel ? "border-primary/50 bg-primary/10 text-primary" : ""
            }`}
          >
            <Zap className="h-3 w-3 shrink-0" />
            <span className="truncate">{chatProvider || chatModel ? `${chatProvider ?? "-"} / ${chatModel ?? "-"}` : t("codingPage.llmSystemDefault")}</span>
          </button>

          {totalTokens > 0 && (
            <span
              className="chip cursor-default select-none"
              title={t("codingPage.contextUsageHint")}
            >
              <Gauge className="h-3 w-3 shrink-0" />
              {formatTokenCount(totalTokens)}
              {contextLength ? ` / ${formatTokenCount(contextLength)}` : ""}
            </span>
          )}

          {isLoading && (
            <span className="chip cursor-default select-none tabular-nums" title={t("codingPage.runDurationHint")}>
              <Clock className="h-3 w-3 shrink-0 animate-pulse" />
              {formatElapsed(elapsedMs)}
            </span>
          )}
        </div>

        {showLLMSelector && (
          <div className="space-y-2 rounded-lg border border-border bg-accent/20 p-2.5">
            <p className="text-[10px] text-muted-foreground">{t("codingPage.llmSelectorHint")}</p>
            {/* Same provider/model query the Bot Builder uses (api.providerModels) - lists the
                real models each configured provider actually has, instead of a hardcoded and
                inevitably-stale guess. */}
            <ProviderModelSelector
              selectedProvider={chatProvider}
              selectedModel={chatModel}
              onProviderChange={setChatProvider}
              onModelChange={setChatModel}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setChatProvider(undefined);
                  setChatModel(undefined);
                }}
                className="flex-1 rounded bg-muted px-2 py-1 text-[11px] transition-colors hover:bg-muted/80"
              >
                {t("codingPage.llmReset")}
              </button>
              <button
                type="button"
                onClick={() => setShowLLMSelector(false)}
                className="flex-1 rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {t("common.done")}
              </button>
            </div>
          </div>
        )}

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
