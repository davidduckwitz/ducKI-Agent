import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Circle, HelpCircle } from "lucide-react";
import { api, type SessionChecklistItem } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { PanelEmpty } from "../ui/panel";

const STATUS_ICON: Record<SessionChecklistItem["status"], typeof CheckCircle2> = {
  done: CheckCircle2,
  failed: AlertCircle,
  unverified: AlertCircle,
  skipped: Circle,
  in_progress: HelpCircle,
  pending: Circle,
};

const STATUS_COLOR: Record<SessionChecklistItem["status"], string> = {
  done: "text-emerald-500",
  failed: "text-destructive",
  unverified: "text-amber-500",
  skipped: "text-muted-foreground/30",
  in_progress: "text-muted-foreground",
  pending: "text-muted-foreground/50",
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * Completed-steps view, sourced directly from the sessionChecklist table (via
 * GET /plans/checklist/:conversationId) instead of scanning `messages` - so unlike the
 * chat/activity tabs it doesn't lose history once old messages are evicted from the
 * paginated message window.
 */
export function CodingDonePanel({
  conversationId,
  isLoading,
}: {
  conversationId?: number;
  isLoading: boolean;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<SessionChecklistItem[]>([]);

  useEffect(() => {
    if (!conversationId) return;
    let active = true;
    const fetchItems = () => {
      void api.plans.checklist(conversationId).then((rows) => {
        if (active) setItems(rows);
      }).catch(() => undefined);
    };
    fetchItems();
    if (!isLoading) return () => { active = false; };
    const interval = setInterval(fetchItems, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [conversationId, isLoading]);

  const done = items.filter((item) => item.status === "done").sort((a, b) => a.stepIndex - b.stepIndex);
  const notable = items
    .filter((item) => item.status === "failed" || item.status === "unverified" || item.status === "skipped")
    .sort((a, b) => a.stepIndex - b.stepIndex);

  if (!conversationId || (done.length === 0 && notable.length === 0)) {
    return (
      <PanelEmpty
        icon={<CheckCircle2 className="h-8 w-8" />}
        title={t("codingPage.noDoneSteps")}
        hint={t("codingPage.noDoneStepsHint")}
      />
    );
  }

  const renderItem = (item: SessionChecklistItem) => {
    const Icon = STATUS_ICON[item.status];
    return (
      <div
        key={item.id}
        className="rounded-lg border border-border bg-background/40 p-2"
      >
        <div className="flex items-start gap-2">
          <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${STATUS_COLOR[item.status]}`} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">
              {item.stepIndex + 1}. {item.title}
            </p>
            {item.description && (
              <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-snug text-muted-foreground">
                {item.description}
              </p>
            )}
            <p className="mt-1 text-[10px] text-muted-foreground/70">{formatTime(item.updatedAt)}</p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
      {done.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            {t("codingPage.tabDone")} ({done.length})
          </p>
          {done.map(renderItem)}
        </div>
      )}
      {notable.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">{t("codingPage.doneOtherSteps")}</p>
          {notable.map(renderItem)}
        </div>
      )}
    </div>
  );
}
