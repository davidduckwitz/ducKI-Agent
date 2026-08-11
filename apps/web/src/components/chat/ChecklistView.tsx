import { CheckCircle2, AlertCircle, Clock, Circle, SkipForward, HelpCircle } from "lucide-react";

/** One checklist step as carried in a `checklist` event's `items` snapshot. */
export interface ChecklistItemView {
  index: number;
  title: string;
  status: "pending" | "in_progress" | "done" | "failed" | "unverified" | "skipped" | string;
}

const STATUS_META: Record<
  string,
  { label: string; badge: string; row: string; icon: JSX.Element }
> = {
  done: {
    label: "Erledigt",
    badge: "bg-green-500/20 text-green-300",
    row: "bg-green-500/10 border-green-500/30",
    icon: <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />,
  },
  unverified: {
    label: "Unbestätigt",
    badge: "bg-yellow-500/20 text-yellow-200",
    row: "bg-yellow-500/10 border-yellow-500/30",
    icon: <HelpCircle className="w-4 h-4 text-yellow-300 shrink-0" />,
  },
  in_progress: {
    label: "In Bearbeitung",
    badge: "bg-blue-500/20 text-blue-300",
    row: "bg-blue-500/10 border-blue-500/30",
    icon: <Clock className="w-4 h-4 text-blue-400 animate-spin shrink-0" />,
  },
  failed: {
    label: "Fehler",
    badge: "bg-red-500/20 text-red-300",
    row: "bg-red-500/10 border-red-500/30",
    icon: <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />,
  },
  skipped: {
    label: "Übersprungen",
    badge: "bg-muted text-muted-foreground",
    row: "bg-muted/40 border-border/70",
    icon: <SkipForward className="w-4 h-4 text-muted-foreground shrink-0" />,
  },
  pending: {
    label: "Offen",
    badge: "bg-muted text-muted-foreground",
    row: "bg-muted/50 border-border/70",
    icon: <Circle className="w-4 h-4 text-muted-foreground shrink-0" />,
  },
};

function meta(status: string) {
  return STATUS_META[status] ?? STATUS_META["pending"]!;
}

/**
 * Renders a session checklist with per-step status. Pure/presentational — it takes the
 * `items` snapshot carried by every `checklist` event, so it works identically for a live
 * run and for a conversation replayed from persisted events.
 */
export function ChecklistView({ items }: { items: ChecklistItemView[] }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const sorted = [...items].sort((a, b) => a.index - b.index);
  // done + unverified both count as "resolved" progress (unverified = accepted under soft policy).
  const resolved = sorted.filter((i) => i.status === "done" || i.status === "unverified").length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="font-medium uppercase tracking-wide">Checkliste</span>
        <span>{resolved}/{sorted.length} erledigt</span>
      </div>
      <ul className="space-y-1.5">
        {sorted.map((item) => {
          const m = meta(item.status);
          return (
            <li key={item.index} className={`flex items-start gap-2 rounded border px-2.5 py-1.5 ${m.row}`}>
              <span className="mt-0.5">{m.icon}</span>
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2 flex-wrap">
                  <span className="text-foreground/85 font-medium text-[13px]">
                    {item.index + 1}. {item.title}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${m.badge}`}>{m.label}</span>
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
