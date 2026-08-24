import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Send, Trash2, Lock, Pencil, Eraser, AlertTriangle } from "lucide-react";
import { api, type BotInfo, type BotInput, type BotChatMessage } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { PageHeader } from "../ui/page-header";
import { Card, CardHeader, CardTitle, CardDescription } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { BotAvatar } from "./BotAvatar";
import { BotBuilderDialog } from "./BotBuilderDialog";
import { MarkdownMessage } from "../chat/MarkdownMessage";

interface ChatMessage {
  role: string;
  content: string;
  stalled?: boolean;
}

export function BotManager() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingBot, setEditingBot] = useState<BotInfo | undefined>(undefined);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");

  const botsQuery = useQuery({ queryKey: ["bots"], queryFn: () => api.bots.list() });
  const selectedBotForHistory = botsQuery.data?.find((b) => b.slug === selectedSlug);
  // The bot's actual persisted history - what the model itself still sees on every turn even
  // though a freshly opened panel LOOKS empty. Showing it (instead of just a blank local buffer)
  // is what makes a stale/wrong earlier answer (which the model tends to repeat verbatim once
  // it's in its own transcript) visible and fixable via "Verlauf löschen" below.
  const historyQuery = useQuery({
    queryKey: ["botHistory", selectedBotForHistory?.conversationId],
    queryFn: () => api.chat.getMessages(selectedBotForHistory!.conversationId!) as Promise<BotChatMessage[]>,
    enabled: Boolean(selectedBotForHistory?.conversationId),
  });

  useEffect(() => {
    if (!selectedSlug) return;
    const persisted = (historyQuery.data ?? [])
      .filter((m) => {
        // Same signal as BotChatRoom.tsx's toDisplayMessages (see its comment for why): an
        // assistant row only counts once BotService.chat() has tagged it authorBotId - every
        // other assistant row is an intermediate tool-loop iteration, and metadata.llmOnly can't
        // tell those apart from the true final reply for a headless bot run (no event emitter, so
        // no separate "assistant_text" display row like the main chat gets). A user-role row
        // counts unless it's tagged internal (the core agent's own post-tool-call nudges).
        if (m.role === "assistant") return Boolean(m.authorBotId);
        if (m.role !== "user") return false;
        if (!m.metadata) return true;
        try {
          return !(JSON.parse(m.metadata) as { internal?: boolean }).internal;
        } catch {
          return true;
        }
      })
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }));
    setMessages(persisted);
  }, [selectedSlug, historyQuery.data]);

  const clearHistoryMutation = useMutation({
    mutationFn: (conversationId: number) => api.chat.clearMessages(conversationId),
    onSuccess: () => {
      setMessages([]);
      queryClient.invalidateQueries({ queryKey: ["botHistory", selectedBotForHistory?.conversationId] });
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: BotInput) => api.bots.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bots"] });
      setBuilderOpen(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ slug, data }: { slug: string; data: BotInput }) => api.bots.update(slug, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bots"] });
      setBuilderOpen(false);
      setEditingBot(undefined);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (slug: string) => api.bots.delete(slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bots"] });
      setSelectedSlug((current) => (current ? null : current));
    },
  });

  const chatMutation = useMutation({
    mutationFn: ({ slug, message }: { slug: string; message: string }) => api.bots.chat(slug, message),
    onSuccess: (result) => {
      setMessages((prev) => [...prev, { role: "assistant", content: result.response, stalled: result.stalled }]);
      // A brand-new bot's first message lazily creates its home conversation server-side - refresh
      // so `bot.conversationId` (and therefore the "Verlauf loeschen" button) picks it up.
      if (!selectedBotForHistory?.conversationId) {
        queryClient.invalidateQueries({ queryKey: ["bots"] });
      }
    },
    onError: (error: Error) => {
      setMessages((prev) => [...prev, { role: "assistant", content: `${t("bots.chatErrorPrefix")} ${error.message}` }]);
    },
  });

  const bots = botsQuery.data ?? [];
  const selectedBot = bots.find((b) => b.slug === selectedSlug);

  function openBot(bot: BotInfo) {
    setSelectedSlug(bot.slug);
    setMessages([]);
  }

  function sendMessage() {
    const text = draft.trim();
    if (!text || !selectedSlug) return;
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setDraft("");
    chatMutation.mutate({ slug: selectedSlug, message: text });
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4 md:p-6">
      <PageHeader
        title={t("bots.title")}
        subtitle={t("bots.subtitle")}
        actions={
          <Button
            size="sm"
            onClick={() => {
              setEditingBot(undefined);
              setBuilderOpen(true);
            }}
          >
            <Plus className="size-4" /> {t("bots.newBot")}
          </Button>
        }
      />

      <BotBuilderDialog
        open={builderOpen}
        onOpenChange={(open) => {
          setBuilderOpen(open);
          if (!open) setEditingBot(undefined);
        }}
        editingBot={editingBot}
        submitting={createMutation.isPending || updateMutation.isPending}
        error={
          createMutation.error instanceof Error
            ? createMutation.error.message
            : updateMutation.error instanceof Error
              ? updateMutation.error.message
              : undefined
        }
        onSubmit={(data) => {
          if (editingBot) {
            updateMutation.mutate({ slug: editingBot.slug, data });
          } else {
            createMutation.mutate(data);
          }
        }}
      />

      <div className="grid flex-1 gap-4 overflow-hidden md:grid-cols-[280px_1fr]">
        <div className="flex flex-col gap-2 overflow-y-auto">
          {bots.map((bot) => (
            <Card
              key={bot.slug}
              className={`cursor-pointer p-3 transition-colors hover:bg-accent ${selectedSlug === bot.slug ? "border-primary" : ""}`}
              onClick={() => openBot(bot)}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <BotAvatar avatar={bot.avatar} size={24} className="shrink-0" />
                  <span className="truncate text-sm font-medium">{bot.name}</span>
                  {bot.isBuiltIn ? (
                    <Badge variant="secondary" className="shrink-0 gap-1">
                      <Lock className="size-3" /> {t("bots.system")}
                    </Badge>
                  ) : null}
                </div>
                {!bot.isBuiltIn ? (
                  <div className="flex shrink-0 items-center">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingBot(bot);
                        setBuilderOpen(true);
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(t("bots.confirmDelete").replace("{name}", bot.name))) deleteMutation.mutate(bot.slug);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ) : null}
              </div>
              {bot.description ? <p className="mt-1 truncate text-xs text-muted-foreground">{bot.description}</p> : null}
            </Card>
          ))}
          {bots.length === 0 ? <p className="p-2 text-sm text-muted-foreground">{t("bots.loading")}</p> : null}
        </div>

        <Card className="flex flex-col overflow-hidden">
          {selectedBot ? (
            <>
              <CardHeader className="flex-row items-center justify-between border-b border-border space-y-0">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <BotAvatar avatar={selectedBot.avatar} size={24} /> {selectedBot.name}
                  </CardTitle>
                  {selectedBot.description ? <CardDescription>{selectedBot.description}</CardDescription> : null}
                </div>
                {selectedBot.conversationId ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={clearHistoryMutation.isPending}
                    onClick={() => {
                      if (confirm(t("bots.confirmClearHistory").replace("{name}", selectedBot.name))) {
                        clearHistoryMutation.mutate(selectedBot.conversationId!);
                      }
                    }}
                  >
                    <Eraser className="size-4" /> {t("bots.clearHistory")}
                  </Button>
                ) : null}
              </CardHeader>
              <div className="flex-1 space-y-2 overflow-y-auto p-4">
                {messages.map((m, i) => (
                  <div key={i} className="max-w-[85%]">
                    <div
                      className={`rounded-lg px-3 py-2 text-sm ${
                        m.role === "user" ? "ml-auto whitespace-pre-wrap bg-primary text-primary-foreground" : "bg-muted"
                      }`}
                    >
                      {m.role === "user" ? m.content : <MarkdownMessage content={m.content} />}
                    </div>
                    {m.stalled ? (
                      <div className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-500">
                        <AlertTriangle className="size-3.5" /> {t("bots.stalledWarning")}
                      </div>
                    ) : null}
                  </div>
                ))}
                {chatMutation.isPending ? (
                  <p className="text-xs text-muted-foreground">{t("bots.thinking").replace("{name}", selectedBot.name)}</p>
                ) : null}
              </div>
              <div className="flex gap-2 border-t border-border p-3">
                <Input
                  placeholder={t("bots.messagePlaceholder").replace("{name}", selectedBot.name)}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                />
                <Button size="icon" onClick={sendMessage} disabled={!draft.trim() || chatMutation.isPending}>
                  <Send className="size-4" />
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t("bots.selectHint")}</div>
          )}
        </Card>
      </div>
    </div>
  );
}
