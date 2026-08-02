import { Loader2, ChevronDown, ChevronRight, Wrench, Check, AlertTriangle } from "lucide-react";
import type { RenderedChatMessage } from "./chatTypes";
import { EventRow } from "./ChatMessageRow";

const ANIMATE_IN = "animate-in fade-in slide-in-from-bottom-1 duration-300";

/**
 * Folds every tool_call/tool_result/tool_retry event that shares one `toolBatchId` (all
 * tool calls issued by a single LLM turn) into one collapsible box, so a turn that fires
 * five tools does not leave five separate boxes in the timeline. Collapsed by default;
 * expanding reveals the individual EventRow entries exactly as before.
 */
export function ToolGroupRow({
  events,
  t,
  expanded,
  onToggle,
  expandedChildren,
  onToggleChild,
}: {
  events: RenderedChatMessage[];
  t: (key: string) => string;
  expanded: boolean;
  onToggle: (open: boolean) => void;
  expandedChildren: Record<string, boolean>;
  onToggleChild: (id: string, open: boolean) => void;
}) {
  const callEvent = events.find((e) => e.eventType === "tool_call");
  const resultEvents = events.filter((e) => e.eventType === "tool_result");
  const expectedCount = (callEvent?.eventData?.["count"] as number | undefined) ?? events.length;
  const isRunning = resultEvents.length < expectedCount;
  const failedCount = resultEvents.filter((e) => e.eventData?.["success"] === false).length;
  const toolNames = (callEvent?.eventData?.["tools"] as string[] | undefined) ?? [];

  const label = isRunning
    ? t("chat.toolGroupRunning").replace("{count}", String(expectedCount))
    : failedCount > 0
      ? t("chat.toolGroupFailed").replace("{count}", String(expectedCount)).replace("{failed}", String(failedCount))
      : t("chat.toolGroupDone").replace("{count}", String(expectedCount));

  const tone = isRunning
    ? "border-amber-500/30 bg-amber-500/[0.07] text-amber-100"
    : failedCount > 0
      ? "border-red-500/40 bg-red-500/10 text-red-100"
      : "border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-100";

  return (
    <details
      open={expanded}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
      className={`${ANIMATE_IN} rounded-lg border px-2.5 py-1.5 text-xs ${tone}`}
    >
      <summary className="list-none cursor-pointer select-none flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          {expanded ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
          {isRunning ? (
            <Loader2 className="w-4 h-4 shrink-0 animate-spin" />
          ) : failedCount > 0 ? (
            <AlertTriangle className="w-4 h-4 shrink-0" />
          ) : (
            <Check className="w-4 h-4 shrink-0" />
          )}
          <Wrench className="w-3.5 h-3.5 shrink-0 opacity-70" />
          <span className="font-medium whitespace-nowrap">{label}</span>
          {toolNames.length > 0 && (
            <span className="truncate opacity-70">{toolNames.join(", ")}</span>
          )}
        </span>
      </summary>
      <div className="mt-2 pl-5 space-y-1.5">
        {events.map((event) => (
          <EventRow
            key={event.id}
            msg={event}
            t={t}
            expanded={expandedChildren[event.id] ?? false}
            onToggle={(open) => onToggleChild(event.id, open)}
          />
        ))}
      </div>
    </details>
  );
}
