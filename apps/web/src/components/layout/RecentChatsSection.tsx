import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pin, PinOff, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useAppStore } from "../../lib/store";
import { useUiStore } from "../../lib/uiStore";
import { CollapsibleSection } from "../ui/collapsible-section";

interface ConversationItem {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Sidebar shows a shortlist only - the chat page keeps the full, searchable list. */
const RECENT_LIMIT = 10;

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
}

export function RecentChatsSection() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { conversationId, setConversationId } = useAppStore();
  const { chatsOpen, toggleSection, pinnedConversationIds, togglePin } = useUiStore();

  // Pinned chats can be older than the newest 10, so fetch a slightly larger window
  // and let the client decide what to show.
  const conversationsQuery = useQuery({
    queryKey: ["chat", "conversations", "sidebar"],
    queryFn: () =>
      api.chat.listConversationsPage({ limit: 40 }) as Promise<{ items: ConversationItem[]; hasMore: boolean }>,
    refetchInterval: 15000,
  });

  const deleteConversation = useMutation({
    mutationFn: (id: number) => api.chat.deleteConversation(id),
    onSuccess: async (_data, deletedId) => {
      if (conversationId === deletedId) setConversationId(undefined);
      await qc.invalidateQueries({ queryKey: ["chat", "conversations"] });
    },
  });

  const { pinned, recent } = useMemo(() => {
    const items = conversationsQuery.data?.items ?? [];
    const pinnedSet = new Set(pinnedConversationIds);
    const pinnedItems = pinnedConversationIds
      .map((id) => items.find((item) => item.id === id))
      .filter((item): item is ConversationItem => Boolean(item));
    const rest = items.filter((item) => !pinnedSet.has(item.id)).slice(0, RECENT_LIMIT);
    return { pinned: pinnedItems, recent: rest };
  }, [conversationsQuery.data?.items, pinnedConversationIds]);

  const openChat = (id: number) => {
    setConversationId(id);
    if (!location.pathname.startsWith("/chat")) navigate("/chat");
  };

  const renderRow = (conv: ConversationItem, isPinned: boolean) => {
    const active = conversationId === conv.id && location.pathname.startsWith("/chat");
    return (
      <div
        key={conv.id}
        className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors ${
          active ? "bg-primary/15 text-foreground ring-1 ring-primary/40" : "hover:bg-accent"
        }`}
      >
        <button onClick={() => openChat(conv.id)} className="min-w-0 flex-1 text-left" title={conv.name}>
          <div className={`truncate text-xs ${active ? "font-semibold" : "font-medium text-foreground/90"}`}>
            {conv.name}
          </div>
          <div className="text-[10px] text-muted-foreground">{formatWhen(conv.updatedAt)}</div>
        </button>
        <button
          onClick={() => togglePin(conv.id)}
          title={isPinned ? t("layout.sidebar.unpin") : t("layout.sidebar.pin")}
          className={`shrink-0 rounded p-1 text-muted-foreground transition hover:bg-background hover:text-foreground ${
            isPinned ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
          }`}
        >
          {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
        </button>
        <button
          onClick={() => {
            if (!window.confirm(`${t("layout.sidebar.deleteChatConfirm")}\n\n${conv.name}`)) return;
            deleteConversation.mutate(conv.id);
          }}
          disabled={deleteConversation.isPending}
          title={t("layout.sidebar.deleteChat")}
          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-background hover:text-destructive focus:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    );
  };

  return (
    <CollapsibleSection
      title={t("layout.sidebar.chats")}
      open={chatsOpen}
      onToggle={() => toggleSection("chats")}
      count={pinned.length + recent.length}
      bodyClassName="space-y-0.5 pb-1"
    >
      {pinned.map((conv) => renderRow(conv, true))}
      {pinned.length > 0 && recent.length > 0 && <div className="my-1 h-px bg-border/70" />}
      {recent.map((conv) => renderRow(conv, false))}
      {conversationsQuery.isLoading && (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("layout.sidebar.loadingChats")}</p>
      )}
      {!conversationsQuery.isLoading && pinned.length + recent.length === 0 && (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("layout.sidebar.noChats")}</p>
      )}
    </CollapsibleSection>
  );
}
