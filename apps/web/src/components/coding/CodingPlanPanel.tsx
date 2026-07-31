import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Circle, ListChecks, Loader2, Play, Sparkles } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { parseMarkdownToPlan } from "../../lib/parseMarkdownToPlan";
import type { Plan } from "../chat/PlanExecutionPanel";
import type { RenderedChatMessage } from "../chat/chatTypes";
import { PanelEmpty } from "../ui/panel";

const COMPLEXITY_LABEL: Record<number, string> = { 1: "niedrig", 3: "mittel", 5: "hoch" };

/**
 * Plan view for the coding agent panel. Deliberately simpler than the chat page's
 * PlanExecutionPanel: step state here is derived from the tool events that arrived
 * after the plan, not from the chat page's heuristics - those stay where they are.
 */
export function CodingPlanPanel({
  messages,
  conversationId,
  isLoading,
  onRefine,
}: {
  messages: RenderedChatMessage[];
  conversationId?: number;
  isLoading: boolean;
  onRefine: (prompt: string) => void;
}) {
  const { t } = useI18n();
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { plan, planIndex } = useMemo<{ plan: Plan | null; planIndex: number }>(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (!msg || msg.eventType !== "plan" || !msg.eventData) continue;
      const data = msg.eventData as unknown as Plan;
      if (data.goal && Array.isArray(data.steps) && data.steps.length > 0) return { plan: data, planIndex: i };
      // Some planners only emit markdown - reuse the chat page's parser for those.
      if (typeof data.markdown === "string") {
        const parsed = parseMarkdownToPlan(data.markdown);
        if (parsed) return { plan: parsed, planIndex: i };
      }
    }
    return { plan: null, planIndex: -1 };
  }, [messages]);

  // Rough live progress: count tool activity after the plan announcement. Enough to see
  // that something is happening without pretending to know which step is running.
  const eventsSincePlan = useMemo(
    () =>
      planIndex < 0
        ? 0
        : messages.slice(planIndex + 1).filter((m) => m.eventType === "tool_call" || m.eventType === "tool_result")
            .length,
    [messages, planIndex]
  );

  if (!plan) {
    return (
      <PanelEmpty
        icon={<ListChecks className="h-8 w-8" />}
        title={t("codingPage.noPlan")}
        hint={t("codingPage.noPlanHint")}
      />
    );
  }

  const steps = plan.steps ?? [];
  const doneCount = Math.min(eventsSincePlan, steps.length);

  const execute = async () => {
    setError(null);
    setExecuting(true);
    try {
      await api.plans.execute(plan.id, {
        goal: plan.goal,
        steps,
        markdown: plan.markdown,
        conversationId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <p className="text-sm font-semibold leading-snug">{plan.title || plan.goal}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="chip">
            {t("codingPage.planSteps")}: {steps.length}
          </span>
          {typeof plan.complexity === "number" && (
            <span className="chip">{COMPLEXITY_LABEL[plan.complexity] ?? plan.complexity}</span>
          )}
          {isLoading && (
            <span className="chip text-amber-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("codingPage.planExecuting")}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {steps.map((step, index) => {
          const done = index < doneCount && !isLoading;
          const running = index === doneCount && isLoading;
          return (
            <div
              key={`${step.title}-${index}`}
              className={`rounded-lg border p-2 transition-colors ${
                running ? "border-primary/50 bg-primary/5" : "border-border bg-background/40"
              }`}
            >
              <div className="flex items-start gap-2">
                {done ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                ) : running ? (
                  <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                ) : (
                  <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">
                    {index + 1}. {step.title}
                  </p>
                  {step.description && (
                    <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-snug text-muted-foreground">
                      {step.description}
                    </p>
                  )}
                  {step.tools && step.tools.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {step.tools.map((tool) => (
                        <span key={tool} className="chip">
                          {tool}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <p className="flex items-start gap-1.5 border-t border-border px-3 py-2 text-[11px] text-destructive">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          {error}
        </p>
      )}

      <div className="flex shrink-0 gap-2 border-t border-border p-2">
        <button
          type="button"
          className="btn-secondary flex-1 py-1.5 text-xs"
          onClick={() =>
            onRefine(
              `Verbessere diesen Plan: ${plan.goal}\n\nBisheriger Plan:\n${plan.markdown || JSON.stringify(plan.steps, null, 2)}`
            )
          }
        >
          <Sparkles className="mr-1 inline h-3.5 w-3.5" />
          {t("codingPage.refinePlan")}
        </button>
        <button
          type="button"
          className="btn-primary flex-1 py-1.5 text-xs"
          onClick={() => void execute()}
          disabled={executing || isLoading}
        >
          <Play className="mr-1 inline h-3.5 w-3.5" />
          {t("codingPage.executePlan")}
        </button>
      </div>
    </div>
  );
}
