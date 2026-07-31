import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, MoreHorizontal, PanelLeft, Pencil, Rows3, Settings, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { DuckyMascot } from "./DuckyMascot";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";

export function ChatHeader({
  title,
  conversationId,
  chatListOpen,
  onToggleChatList,
  compactMode,
  onToggleCompact,
  onClear,
  onOpenSettings,
  isLoading,
  connected,
}: {
  title?: string;
  conversationId?: number;
  chatListOpen: boolean;
  onToggleChatList: () => void;
  compactMode: boolean;
  onToggleCompact: () => void;
  onClear: () => void;
  onOpenSettings: () => void;
  isLoading: boolean;
  connected: boolean;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title ?? "");

  useEffect(() => {
    setDraftTitle(title ?? "");
    setRenaming(false);
  }, [title, conversationId]);

  const rename = useMutation({
    mutationFn: (name: string) => api.chat.updateConversation(conversationId as number, { name }),
    onSuccess: async () => {
      setRenaming(false);
      await qc.invalidateQueries({ queryKey: ["chat", "conversations"] });
    },
  });

  const submitRename = () => {
    const next = draftTitle.trim();
    if (!next || !conversationId || next === title) {
      setRenaming(false);
      return;
    }
    rename.mutate(next);
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      <button
        onClick={onToggleChatList}
        title={t("chat.allChats")}
        className={`flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition ${
          chatListOpen ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"
        }`}
      >
        <PanelLeft className="h-4 w-4" />
      </button>

      <DuckyMascot
        working={isLoading}
        connected={connected}
        size={24}
        title={isLoading ? t("chat.duckyWorkingTitle") : t("chat.duckyIdleTitle")}
      />

      {renaming ? (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <input
            autoFocus
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") {
                setDraftTitle(title ?? "");
                setRenaming(false);
              }
            }}
            className="input min-w-0 flex-1 py-1 text-sm"
            placeholder={t("chat.renamePlaceholder")}
          />
          <button
            onClick={submitRename}
            disabled={rename.isPending}
            className="rounded p-1 text-primary transition hover:bg-accent"
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            onClick={() => {
              setDraftTitle(title ?? "");
              setRenaming(false);
            }}
            className="rounded p-1 text-muted-foreground transition hover:bg-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => conversationId && setRenaming(true)}
          disabled={!conversationId}
          title={conversationId ? t("chat.rename") : undefined}
          className="group flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left transition hover:bg-accent disabled:hover:bg-transparent"
        >
          <span className="truncate text-sm font-medium">{title || t("chat.untitled")}</span>
          {conversationId && (
            <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
          )}
        </button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            title={t("chat.moreActions")}
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={onToggleCompact} className="gap-2">
            <Rows3 className="h-4 w-4" />
            {compactMode ? t("chat.comfort") : t("chat.compact")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onOpenSettings} className="gap-2">
            <Settings className="h-4 w-4" />
            {t("chat.chatSettings")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onClear} className="gap-2 text-destructive focus:text-destructive">
            <Trash2 className="h-4 w-4" />
            {t("chat.clear")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
