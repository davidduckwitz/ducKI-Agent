import { Ban, Check, CircleDashed, HelpCircle, Loader2, TriangleAlert } from "lucide-react";

export interface CodingTodoItem {
  id: number;
  title: string;
  status: "pending" | "in_progress" | "done" | "blocked" | "failed" | "skipped" | "unverified" | "unknown";
  note?: string;
}

const STATUS_ICON = {
  pending: CircleDashed,
  in_progress: Loader2,
  done: Check,
  blocked: TriangleAlert,
  failed: TriangleAlert,
  skipped: Ban,
  unverified: TriangleAlert,
  unknown: HelpCircle,
} as const;

const STATUS_CLASS = {
  pending: "text-muted-foreground",
  in_progress: "text-primary",
  done: "text-emerald-500",
  blocked: "text-amber-500",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
  unverified: "text-amber-500",
  unknown: "text-muted-foreground",
} as const;

const STATUS_LABEL: Record<CodingTodoItem["status"], string> = {
  pending: "Offen",
  in_progress: "Aktuell",
  done: "Erfolgreich",
  blocked: "Fehlgeschlagen",
  failed: "Fehlgeschlagen",
  skipped: "Übersprungen",
  unverified: "Unbestätigt",
  unknown: "Unbekannt",
};

/**
 * The agent's live checklist.
 *
 * This is the same state the agent steers by - it comes from its `todo` tool calls, not from
 * parsing what it wrote about itself. So a step shown as done here is one the agent actually
 * marked done after verifying it, which is the difference between a progress display and a
 * narration of intentions.
 */
export function CodingTodoStrip({ items }: { items: CodingTodoItem[] }) {
  if (items.length === 0) return null;

  const done = items.filter((item) => item.status === "done").length;

  return (
    <div className="shrink-0 border-b border-border bg-muted/30 px-2 py-1.5">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>Checkliste</span>
        <span>
          {done}/{items.length}
        </span>
      </div>
      <ul className="space-y-0.5">
        {items.map((item) => {
          const Icon = STATUS_ICON[item.status] ?? CircleDashed;
          return (
            <li key={item.id} className="flex items-start gap-1.5 text-xs">
              <Icon
                className={`mt-0.5 h-3 w-3 shrink-0 ${STATUS_CLASS[item.status] ?? "text-muted-foreground"} ${
                  item.status === "in_progress" ? "animate-spin" : ""
                }`}
              />
              <span
                className={`min-w-0 flex-1 ${
                  item.status === "done" ? "text-muted-foreground line-through" : "text-foreground"
                }`}
              >
                {item.title}
                <span className="ml-1 text-[10px] text-muted-foreground">({STATUS_LABEL[item.status] ?? "Unbekannt"})</span>
                {item.note && <span className="ml-1 text-[10px] text-muted-foreground">— {item.note}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
