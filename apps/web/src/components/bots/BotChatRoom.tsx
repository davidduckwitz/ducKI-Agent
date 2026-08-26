import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Send, UserPlus, AlertTriangle, Sparkles, Trash2, X, FolderOpen, FileText, ChevronRight, ChevronDown, ClipboardList, Pencil, Check } from "lucide-react";
import { api, type BotChatMessage, type BotInfo } from "../../lib/api";
import { Card, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MarkdownMessage } from "../chat/MarkdownMessage";
import { botAccentColor } from "./botAvatarColor";

interface DisplayMessage {
  key: string;
  role: "user" | "bot";
  authorBotId?: string;
  authorName?: string;
  content: string;
  needsUserDecision?: boolean;
  /** True for the synthesized plan artifact that ends a planning exchange (metadata.plan). */
  isPlan?: boolean;
  /** Absolute path of the plan markdown in the group's shared workspace (metadata.planPath). */
  planPath?: string;
  /** True once a newer planning exchange superseded this plan (metadata.archived). */
  archived?: boolean;
  /** Real DB row id - only set for persisted messages, which is what makes them deletable
   *  (an in-flight optimistic turn has no row yet, so there's nothing to delete server-side). */
  dbId?: number;
}

function BotAvatarCircle({ slug, name }: { slug: string; name: string }) {
  const color = botAccentColor(slug);
  return (
    <div
      className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${color.bg} ${color.text} ring-2 ${color.ring}`}
      title={name}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function toDisplayMessages(rows: BotChatMessage[], botBySlug: Map<string, BotInfo>): DisplayMessage[] {
  return rows
    .filter((m) => {
      // Positive signal, not a metadata-flag guess: BotService.chat() tags exactly the row it
      // resolved as this bot's real, final reply with authorBotId - every OTHER assistant row is
      // an intermediate tool-loop iteration (Agent.run() persists one per iteration, marked
      // metadata.llmOnly, indistinguishable in content from a genuine short reply). A metadata
      // filter alone can't tell those apart for a bot run: unlike the interactive main chat, a
      // bot has no event emitter, so it never gets the separate "assistant_text" display row that
      // main chat relies on there - llmOnly ends up on 100% of a bot's assistant rows, including
      // the true final one, so filtering it out would hide every bot reply, not just scaffolding.
      if (m.role === "assistant") {
        if (!m.authorBotId) return false;
        // A bot that had nothing to add replies with the literal "(pass)" token (see
        // BotChatOrchestrator's PASS_RE) instead of padding out a reply - tagged
        // metadata.pass by the orchestrator specifically so it never shows here, the whole
        // point of the convention being a silent, cheap opt-out rather than visible filler.
        if (m.metadata) {
          try {
            if ((JSON.parse(m.metadata) as { pass?: boolean }).pass) return false;
          } catch {
            // ignore malformed metadata
          }
        }
        return true;
      }
      if (m.role !== "user") return false;
      // A user-role row with no `internal` tag is the one real, once-only record of what the
      // human typed (see BotChatOrchestrator.handleUserMessage's upfront db.addMessage) - every
      // other user-role row is either our own synthetic "you were asked to respond" directive
      // (tagPromptAsInternal, tagged internal by BotService.chat) or the core agent's own
      // post-tool-call nudge (already tagged internal by agent.ts itself). Neither was ever meant
      // for a human to read.
      let internal = false;
      if (m.metadata) {
        try {
          internal = Boolean((JSON.parse(m.metadata) as { internal?: boolean }).internal);
        } catch {
          // ignore malformed metadata
        }
      }
      return !internal;
    })
    .filter((m) => m.content.trim().length > 0)
    .map((m) => {
      let needsUserDecision = false;
      let isPlan = false;
      let archived = false;
      let planPath: string | undefined;
      if (m.metadata) {
        try {
          const parsed = JSON.parse(m.metadata) as {
            needsUserDecision?: boolean;
            plan?: boolean;
            archived?: boolean;
            planPath?: string;
          };
          needsUserDecision = Boolean(parsed.needsUserDecision);
          isPlan = Boolean(parsed.plan);
          archived = Boolean(parsed.archived);
          planPath = typeof parsed.planPath === "string" ? parsed.planPath : undefined;
        } catch {
          // ignore malformed metadata
        }
      }
      const bot = m.authorBotId ? botBySlug.get(m.authorBotId) : undefined;
      return {
        key: `db-${m.id}`,
        role: m.role === "user" ? "user" : "bot",
        authorBotId: m.authorBotId ?? undefined,
        authorName: bot?.name ?? m.authorBotId ?? undefined,
        content: m.content,
        needsUserDecision,
        isPlan,
        planPath,
        archived,
        dbId: m.id,
      } satisfies DisplayMessage;
    });
}

export function BotChatRoom() {
  const { id } = useParams<{ id: string }>();
  const conversationId = Number(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [pendingUserText, setPendingUserText] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // While true, messages + status are polled every ~1.2s so a bot's reply shows up the moment
  // it's actually persisted server-side, instead of the UI waiting for the whole multi-bot
  // exchange to finish before revealing anything (see routes/bot-chats.ts: the POST responds as
  // soon as the user's message is saved, then keeps running bots in the background).
  const [polling, setPolling] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  // Pinned "Active Plan" strip: the latest plan artifact from a converged planning exchange,
  // kept open so the room shows the plan that a follow-up execution message will drive from.
  const [showActivePlan, setShowActivePlan] = useState(true);
  // Inline plan editing: the plan card swaps its markdown for a textarea while a draft is open.
  const [editingPlanKey, setEditingPlanKey] = useState<string | null>(null);
  const [planDraft, setPlanDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const chatQuery = useQuery({
    queryKey: ["botChat", conversationId],
    queryFn: () => api.botChats.get(conversationId),
    enabled: Number.isFinite(conversationId),
  });
  const botsQuery = useQuery({ queryKey: ["bots"], queryFn: () => api.bots.list() });
  const messagesQuery = useQuery({
    queryKey: ["botChatMessages", conversationId],
    queryFn: () => api.botChats.getMessages(conversationId),
    enabled: Number.isFinite(conversationId),
    refetchInterval: polling ? 1200 : false,
  });
  const statusQuery = useQuery({
    queryKey: ["botChatStatus", conversationId],
    queryFn: () => api.botChats.status(conversationId),
    enabled: polling,
    refetchInterval: polling ? 1200 : false,
  });
  const workspaceQuery = useQuery({
    queryKey: ["botChatWorkspace", conversationId],
    queryFn: () => api.botChats.getWorkspace(conversationId),
    enabled: showWorkspace && Number.isFinite(conversationId),
    refetchInterval: polling ? 3000 : false,
  });
  const filePreviewQuery = useQuery({
    queryKey: ["botChatFilePreview", conversationId, previewFile],
    queryFn: () => api.botChats.getWorkspaceFile(conversationId, previewFile!),
    enabled: previewFile !== null && Number.isFinite(conversationId),
  });

  // The exchange has settled server-side: do one last refetch to catch anything written between
  // the last poll and the background run actually finishing, then stop polling.
  useEffect(() => {
    if (polling && statusQuery.data?.generating === false) {
      messagesQuery.refetch();
      setPolling(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, statusQuery.data?.generating]);

  const bots = botsQuery.data ?? [];
  const botBySlug = useMemo(() => new Map(bots.map((b) => [b.slug, b])), [bots]);
  const participants = (chatQuery.data?.participants ?? [])
    .map((slug) => botBySlug.get(slug))
    .filter((b): b is BotInfo => Boolean(b));
  const availableToAdd = bots.filter((b) => !chatQuery.data?.participants.includes(b.slug));

  const persisted = useMemo(() => toDisplayMessages(messagesQuery.data ?? [], botBySlug), [messagesQuery.data, botBySlug]);
  const display: DisplayMessage[] = [
    ...persisted,
    ...(pendingUserText ? [{ key: "pending-user", role: "user" as const, content: pendingUserText }] : []),
  ];
  // The "active" plan is the newest plan artifact in the transcript - the same one a follow-up
  // execution message picks up from the shared workspace (BotChatOrchestrator.findActivePlan).
  const latestPlan = useMemo(() => {
    for (let index = persisted.length - 1; index >= 0; index--) {
      const candidate = persisted[index];
      // Skip archived (superseded) plans - only the newest, still-active one is pinned.
      if (candidate?.isPlan && !candidate.archived) return candidate;
    }
    return undefined;
  }, [persisted]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [display.length]);

  const sendMutation = useMutation({
    mutationFn: (message: string) => api.botChats.sendMessage(conversationId, message),
    onMutate: (message) => {
      setPendingUserText(message);
      setSendError(null);
    },
    onSuccess: async () => {
      // The user's own message is already persisted by the time this resolves (the route awaits
      // that write before responding) - show it immediately, then start polling for bot replies.
      await messagesQuery.refetch();
      setPendingUserText(null);
      setPolling(true);
    },
    onError: (error: Error) => {
      setPendingUserText(null);              setSendError(error.message || "Message could not be sent.");
    },
  });

  const addParticipantMutation = useMutation({
    mutationFn: (slug: string) => api.botChats.addParticipant(conversationId, slug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["botChat", conversationId] }),
  });

  const deleteMessageMutation = useMutation({
    mutationFn: (messageId: number) => api.botChats.deleteMessage(conversationId, messageId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["botChatMessages", conversationId] }),
  });

  const updatePlanMutation = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      api.botChats.updatePlan(conversationId, path, content),
    onSuccess: async () => {
      setEditingPlanKey(null);
      await messagesQuery.refetch();
    },
    onError: (error: Error) => setSendError(error.message || "Plan could not be saved."),
  });

  const deleteChatMutation = useMutation({
    mutationFn: () => api.botChats.delete(conversationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["botChats"] });
      navigate("/bot-chats");
    },
  });

  function handleDraftChange(value: string) {
    setDraft(value);
    const cursorWord = value.slice(0, value.length).split(/\s/).pop() ?? "";
    if (cursorWord.startsWith("@") && cursorWord.length >= 1) {
      setMentionQuery(cursorWord.slice(1).toLowerCase());
    } else {
      setMentionQuery(null);
    }
  }

  function applyMention(slug: string) {
    const parts = draft.split(/\s/);
    parts[parts.length - 1] = `@${slug}`;
    setDraft(parts.join(" ") + " ");
    setMentionQuery(null);
    inputRef.current?.focus();
  }

  function send() {
    const text = draft.trim();
    if (!text || sendMutation.isPending) return;
    setDraft("");
    setMentionQuery(null);
    sendMutation.mutate(text);
  }

  const mentionMatches = mentionQuery !== null
    ? participants.filter((b) => b.slug.includes(mentionQuery) || b.name.toLowerCase().includes(mentionQuery))
    : [];

  return (
    <div className="flex h-full flex-col gap-3 p-4 md:p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/bot-chats")}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold">{chatQuery.data?.name ?? "Group Chat"}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {participants.map((bot) => (
              <span key={bot.slug} className="flex items-center gap-1 text-xs text-muted-foreground">
                <BotAvatarCircle slug={bot.slug} name={bot.name} />
                {bot.name}
              </span>
            ))}
            {availableToAdd.length > 0 ? (
              <select
                className="ml-1 rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground"
                value=""
                onChange={(e) => {
                  if (e.target.value) addParticipantMutation.mutate(e.target.value);
                }}
              >
                <option value="">
                  <UserPlus className="size-3" /> + Add Bot
                </option>
                {availableToAdd.map((bot) => (
                  <option key={bot.slug} value={bot.slug}>
                    {bot.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setShowWorkspace(!showWorkspace)}
          className={showWorkspace ? "text-primary" : ""}
          title="Toggle workspace files"
        >
          <FolderOpen className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={deleteChatMutation.isPending}
          onClick={() => {
            if (confirm(`Delete group chat "${chatQuery.data?.name ?? ""}"? The entire history will be lost.`)) {
              deleteChatMutation.mutate();
            }
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      <div className="flex flex-1 gap-3 overflow-hidden">
      {showWorkspace ? (
        <Card className="flex w-72 shrink-0 flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <FolderOpen className="size-4 text-muted-foreground" />
            <span className="text-xs font-semibold text-muted-foreground">Workspace Files</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {workspaceQuery.data?.files && workspaceQuery.data.files.length > 0 ? (
              workspaceQuery.data.files.map((f) => (
                <div
                  key={f.path}
                  className={`flex cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-xs hover:bg-accent ${previewFile === f.path ? "bg-accent" : ""}`}
                  onClick={() => !f.isDirectory && setPreviewFile(previewFile === f.path ? null : f.path)}
                >
                  {f.isDirectory ? (
                    <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate font-mono" title={f.path}>{f.path}</span>
                  {!f.isDirectory && f.size > 0 ? (
                    <span className="ml-auto shrink-0 text-muted-foreground/60">
                      {f.size > 1024 ? `${Math.round(f.size / 1024)}KB` : `${f.size}B`}
                    </span>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="p-2 text-center text-xs text-muted-foreground">No files yet</p>
            )}
          </div>
          {previewFile ? (
            <div className="border-t border-border">
              <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                <span className="truncate text-xs font-mono text-muted-foreground">{previewFile}</span>
                <button type="button" onClick={() => setPreviewFile(null)} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                  <X className="size-3" />
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto p-2">
                {filePreviewQuery.isLoading ? (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                ) : filePreviewQuery.data ? (
                  <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/80">{filePreviewQuery.data.content}</pre>
                ) : (
                  <p className="text-xs text-destructive">Failed to load file</p>
                )}
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card className="flex flex-1 flex-col overflow-hidden">
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
          {latestPlan ? (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 shadow-sm">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
                onClick={() => setShowActivePlan(!showActivePlan)}
              >
                <ClipboardList className="size-4 shrink-0 text-emerald-600" />
                <span className="text-sm font-semibold">Active Plan</span>
                <span className="truncate font-mono text-xs text-muted-foreground" title={latestPlan.planPath}>
                  {latestPlan.planPath}
                </span>
                {showActivePlan ? (
                  <ChevronDown className="ml-auto size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
                )}
              </button>
              {showActivePlan ? (
                <div className="border-t border-emerald-500/20 px-3 pb-3 pt-2 text-sm">
                  <MarkdownMessage content={latestPlan.content} />
                </div>
              ) : null}
            </div>
          ) : null}
          {display.map((msg) => {
            const deleteButton = msg.dbId !== undefined ? (
              <button
                type="button"
                title="Delete message"
                className="mt-0.5 shrink-0 self-start rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive group-hover:opacity-100"
                onClick={() => {
                  if (confirm("Diese Nachricht löschen?")) deleteMessageMutation.mutate(msg.dbId!);
                }}
              >
                <X className="size-3.5" />
              </button>
            ) : null;

            if (msg.role === "user") {
              return (
                <div key={msg.key} className="group ml-auto flex max-w-[75%] items-start gap-1">
                  <div className="rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground shadow-sm">
                    {msg.content}
                  </div>
                  {deleteButton}
                </div>
              );
            }

            if (msg.isPlan) {
              // A converged planning exchange renders as a dedicated plan card, not a regular bot
              // bubble: the synthesized markdown plus the artifact path in the shared workspace.
              // Superseded plans (archived by a newer planning exchange) render dimmed without an
              // edit affordance - their file was moved to output/archive/.
              const planBody = msg.content
                .replace(/^##\s*📋?\s*Gemeinsamer Plan\s*\n+/, "")
                .replace(/\n+_Plan gespeichert: .*_$/, "")
                .trim();
              const editing = editingPlanKey === msg.key;
              return (
                <div key={msg.key} className="group flex items-start gap-2">
                  <div
                    className={`min-w-0 flex-1 rounded-xl border px-4 py-3 shadow-sm ${
                      msg.archived
                        ? "border-muted-foreground/20 bg-muted/40 opacity-70"
                        : "border-emerald-500/30 bg-emerald-500/5"
                    }`}
                  >
                    <div
                      className={`mb-1 flex items-center gap-1.5 text-xs font-semibold ${
                        msg.archived ? "text-muted-foreground" : "text-emerald-600"
                      }`}
                    >
                      <ClipboardList className="size-3.5 shrink-0" />
                      Gemeinsamer Plan
                      {msg.authorName ? <span className="font-normal text-muted-foreground">· {msg.authorName}</span> : null}
                      {msg.archived ? (
                        <span className="ml-auto rounded border border-muted-foreground/30 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Archiviert
                        </span>
                      ) : (
                        <button
                          type="button"
                          title={editing ? "Schließen" : "Plan bearbeiten"}
                          className="ml-auto rounded p-1 text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-700"
                          onClick={() => {
                            if (editing) {
                              setEditingPlanKey(null);
                            } else {
                              setEditingPlanKey(msg.key);
                              setPlanDraft(planBody);
                            }
                          }}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                      )}
                    </div>
                    {editing ? (
                      <div className="space-y-2">
                        <textarea
                          className="input min-h-48 w-full resize-y font-mono text-xs leading-relaxed"
                          value={planDraft}
                          onChange={(e) => setPlanDraft(e.target.value)}
                          spellCheck={false}
                          placeholder="Plan-Markdown bearbeiten…"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            className="flex items-center gap-1"
                            disabled={updatePlanMutation.isPending || !msg.planPath || !planDraft.trim()}
                            onClick={() => msg.planPath && updatePlanMutation.mutate({ path: msg.planPath, content: planDraft })}
                          >
                            <Check className="size-3.5" /> Speichern
                          </Button>
                          <Button size="sm" variant="ghost" className="flex items-center gap-1" onClick={() => setEditingPlanKey(null)}>
                            <X className="size-3.5" /> Abbrechen
                          </Button>
                          {updatePlanMutation.isPending ? (
                            <span className="text-xs text-muted-foreground">Wird gespeichert…</span>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm">
                        <MarkdownMessage content={planBody} />
                      </div>
                    )}
                    {msg.planPath && !msg.archived ? (
                      <button
                        type="button"
                        title="Open plan file in the workspace"
                        className="mt-2 block w-full truncate rounded font-mono text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                        onClick={() => {
                          setPreviewFile(msg.planPath!);
                          setShowWorkspace(true);
                        }}
                      >
                        {msg.planPath}
                      </button>
                    ) : null}
                  </div>
                  {deleteButton}
                </div>
              );
            }

            const color = botAccentColor(msg.authorBotId ?? "bot");
            return (
              <div key={msg.key} className="group flex max-w-[90%] items-start gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <BotAvatarCircle slug={msg.authorBotId ?? "bot"} name={msg.authorName ?? "Bot"} />
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 text-xs font-semibold text-muted-foreground">{msg.authorName}</div>
                  <div className={`rounded-2xl rounded-tl-sm px-4 py-2 text-sm shadow-sm ${color.bg} ring-1 ${color.ring}`}>
                    <MarkdownMessage content={msg.content} />
                  </div>
                  {msg.needsUserDecision ? (
                    <div className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-500">
                      <AlertTriangle className="size-3.5" /> Needs your decision
                    </div>
                  ) : null}
                </div>
                {deleteButton}
              </div>
            );
          })}

          {(polling || sendMutation.isPending) && (statusQuery.data?.activeBots?.length ?? 0) > 0 ? (
            <div className="flex flex-col gap-1">
              {statusQuery.data!.activeBots.map((bot) => (
                <div key={bot.slug} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <BotAvatarCircle slug={bot.slug} name={bot.name} />
                  <span>{bot.name} {bot.activity === "thinking…" ? "is thinking…" : bot.activity}</span>
                </div>
              ))}
            </div>
          ) : null}
          {(polling || sendMutation.isPending) && (statusQuery.data?.activeBots?.length ?? 0) === 0 ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Sparkles className="size-3.5 animate-pulse" />
              Bots are responding…
            </div>
          ) : null}

          {display.length === 0 && !polling && !sendMutation.isPending ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Write a message - relevant bots respond automatically, or mention a specific bot with @name.
            </p>
          ) : null}
        </div>

        <div className="relative border-t border-border p-3">
          {sendError ? (
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-destructive">
              <AlertTriangle className="size-3.5" /> {sendError}
            </div>
          ) : null}
          {mentionMatches.length > 0 ? (
            <div className="absolute bottom-full left-3 mb-2 w-64 rounded-lg border border-border bg-popover p-1 shadow-lg">
              {mentionMatches.map((bot) => (
                <button
                  key={bot.slug}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => applyMention(bot.slug)}
                >
                  <BotAvatarCircle slug={bot.slug} name={bot.name} />
                  <span className="font-medium">{bot.name}</span>
                  <span className="text-xs text-muted-foreground">@{bot.slug}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              placeholder="Write a message, @ to mention a specific bot…"
              value={draft}
              onChange={(e) => handleDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
                if (e.key === "Escape") setMentionQuery(null);
              }}
            />
            <Button size="icon" onClick={send} disabled={!draft.trim() || sendMutation.isPending}>
              <Send className="size-4" />
            </Button>
          </div>
        </div>
      </Card>
      </div>
    </div>
  );
}
