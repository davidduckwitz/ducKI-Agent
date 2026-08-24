import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Users, Plus, Sparkles, Trash2 } from "lucide-react";
import { api, type BotInfo } from "../../lib/api";
import { PageHeader } from "../ui/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { botAccentColor } from "./botAvatarColor";

function BotChip({ bot }: { bot: BotInfo }) {
  const color = botAccentColor(bot.slug);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${color.bg} ${color.text}`}
    >
      <span className={`flex size-4 items-center justify-center rounded-full ${color.bg} ring-1 ${color.ring}`}>
        {bot.name.charAt(0).toUpperCase()}
      </span>
      {bot.name}
    </span>
  );
}

export function BotChatList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [chatName, setChatName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const botsQuery = useQuery({ queryKey: ["bots"], queryFn: () => api.bots.list() });
  const chatsQuery = useQuery({ queryKey: ["botChats"], queryFn: () => api.botChats.list() });
  const bots = botsQuery.data ?? [];
  const botBySlug = new Map(bots.map((b) => [b.slug, b]));

  const createMutation = useMutation({
    mutationFn: () => api.botChats.create({ name: chatName.trim() || undefined, botSlugs: [...selected] }),
    onSuccess: (chat) => {
      queryClient.invalidateQueries({ queryKey: ["botChats"] });
      setDialogOpen(false);
      setChatName("");
      setSelected(new Set());
      navigate(`/bot-chats/${chat.id}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.botChats.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["botChats"] }),
  });

  function toggle(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4 md:p-6">
      <PageHeader
        title="Gruppen-Chats"
        subtitle="Mehrere Bots in einem gemeinsamen Chat - per @Erwähnung ansprechen oder automatisch mitreden lassen."
        actions={
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="size-4" /> Neuer Gruppen-Chat
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(chatsQuery.data ?? []).map((chat) => (
          <Card
            key={chat.id}
            className="cursor-pointer p-4 transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-lg"
            onClick={() => navigate(`/bot-chats/${chat.id}`)}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Users className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-semibold">{chat.name}</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Gruppen-Chat "${chat.name}" löschen? Der gesamte Verlauf geht verloren.`)) {
                    deleteMutation.mutate(chat.id);
                  }
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {chat.participants.map((slug) => {
                const bot = botBySlug.get(slug);
                return bot ? <BotChip key={slug} bot={bot} /> : null;
              })}
            </div>
          </Card>
        ))}
        {chatsQuery.data?.length === 0 ? (
          <Card className="col-span-full flex flex-col items-center gap-2 border-dashed p-10 text-center">
            <Sparkles className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Noch kein Gruppen-Chat. Lege einen an und lass mehrere Bots gemeinsam an einer Aufgabe arbeiten.
            </p>
          </Card>
        ) : null}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Neuer Gruppen-Chat</DialogTitle>
            <DialogDescription>Wähle mindestens zwei Bots, die gemeinsam in diesem Chat mitreden sollen.</DialogDescription>
          </DialogHeader>
          <Input placeholder="Name (optional)" value={chatName} onChange={(e) => setChatName(e.target.value)} />
          <div className="grid max-h-64 gap-2 overflow-y-auto">
            {bots.map((bot) => (
              <label
                key={bot.slug}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border p-2 text-sm transition-colors ${
                  selected.has(bot.slug) ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
                }`}
              >
                <input type="checkbox" checked={selected.has(bot.slug)} onChange={() => toggle(bot.slug)} className="size-4" />
                <span className="font-medium">{bot.name}</span>
                {bot.description ? <span className="truncate text-xs text-muted-foreground">{bot.description}</span> : null}
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button disabled={selected.size < 2 || createMutation.isPending} onClick={() => createMutation.mutate()}>
              Chat erstellen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
