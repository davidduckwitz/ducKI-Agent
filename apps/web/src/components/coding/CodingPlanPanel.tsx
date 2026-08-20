import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Circle, ListChecks, Loader2, Play, Sparkles } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { parseMarkdownToPlan } from "../../lib/parseMarkdownToPlan";
import { findLatestChecklist, firstOpenStepIndex, resolveStepStatus } from "../../lib/planChecklist";
import { useSettings, readFlag } from "../../lib/useSettings";
import type { Plan } from "../chat/PlanExecutionPanel";
import type { RenderedChatMessage } from "../chat/chatTypes";
import { PanelEmpty } from "../ui/panel";
import { PlanRefinementDialog } from "./PlanRefinementDialog";

const COMPLEXITY_LABEL: Record<number, string> = { 1: "niedrig", 3: "mittel", 5: "hoch" };

/**
 * Plan view for the coding agent panel.
 *
 * Per-step state comes from the agent's own checklist events (see lib/planChecklist), which is
 * the only place that actually knows whether a step completed. It used to be inferred from how
 * many tool calls had happened since the plan was announced - a number unrelated to step
 * completion, and additionally suppressed while the run was in progress, so the list never
 * ticked anything off until the run ended and then ticked off the wrong things.
 */
export function CodingPlanPanel({
  messages,
  conversationId,
  isLoading,
  overridePlan,
  onExecutePlan,
  onRefine,
}: {
  messages: RenderedChatMessage[];
  conversationId?: number;
  isLoading: boolean;
  overridePlan?: Plan | null;
  onExecutePlan?: (plan: Plan) => Promise<void>;
  onRefine: (prompt: string) => void;
}) {
  const { t } = useI18n();
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRefinement, setShowRefinement] = useState(false);
  const settingsQuery = useSettings();
  const autoExecuteEnabled = readFlag(settingsQuery.data, "PLAN_MODE_AUTO_EXECUTE");
  // Set right before a refinement prompt is submitted; consumed by the auto-execute effect
  // below once the refined plan actually arrives, so a normal (non-refinement) plan event
  // never triggers an unrequested execution.
  const refinementPendingRef = useRef(false);
  const lastAutoExecutedPlanIndexRef = useRef(-1);

  const { plan: derivedPlan, planIndex } = useMemo<{ plan: Plan | null; planIndex: number }>(() => {
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

  // Prefer a plan from this conversation's messages; fall back to a plan handed
  // over from the chat page (which lives in a different conversation).
  const plan = derivedPlan ?? overridePlan ?? null;

  // Real per-step state from the agent's own checklist (see lib/planChecklist for why this
  // replaced a tool-call counter, and why the logic lives in a testable module).
  const checklist = useMemo(() => findLatestChecklist(messages), [messages]);

  const steps = plan?.steps ?? [];
  const statusOf = (step: { title: string }, index: number) => resolveStepStatus(checklist, step, index);
  const runningIndex = useMemo(() => firstOpenStepIndex(checklist, steps), [checklist, steps]);
  const doneCount = checklist?.doneCount ?? 0;

  const execute = async () => {
    if (!plan) return;
    setError(null);
    setExecuting(true);
    try {
      if (onExecutePlan) {
        // Robust path: parent guarantees a coding project + conversation exist and
        // passes the project slug through so files land in the project sandbox.
        await onExecutePlan(plan);
      } else {
        await api.plans.execute(plan.id, {
          goal: plan.goal,
          steps,
          markdown: plan.markdown,
          conversationId,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
    }
  };

  // PLAN_MODE_AUTO_EXECUTE: once a refined plan arrives (refinementPendingRef was set right
  // before submitting the refinement prompt), start execution automatically instead of
  // waiting for a manual "Execute" click. Never fires for the plan's initial creation or any
  // other unrelated plan event - only the refinement round-trip sets the pending flag.
  useEffect(() => {
    if (!autoExecuteEnabled) return;
    if (!refinementPendingRef.current) return;
    if (planIndex < 0 || planIndex === lastAutoExecutedPlanIndexRef.current) return;
    refinementPendingRef.current = false;
    lastAutoExecutedPlanIndexRef.current = planIndex;
    void execute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planIndex, autoExecuteEnabled]);

  if (!plan) {
    return (
      <PanelEmpty
        icon={<ListChecks className="h-8 w-8" />}
        title={t("codingPage.noPlan")}
        hint={t("codingPage.noPlanHint")}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <p className="text-sm font-semibold leading-snug">{plan.title || plan.goal}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="chip">
            {/* Only claim progress when the agent actually reported it. Without a checklist
                (a plain coding chat rather than a plan execution) there is no per-step truth,
                and inventing one is what made this panel misleading in the first place. */}
            {checklist
              ? `${t("codingPage.planSteps")}: ${doneCount}/${steps.length}`
              : `${t("codingPage.planSteps")}: ${steps.length}`}
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
          const status = statusOf(step, index);
          const done = status === "done";
          const failed = status === "failed";
          const unverified = status === "unverified";
          const skipped = status === "skipped";
          const running = isLoading && !done && !failed && !skipped && index === runningIndex;

          return (
            <div
              key={`${step.title}-${index}`}
              className={`rounded-lg border p-2 transition-colors ${
                running
                  ? "border-primary/50 bg-primary/5"
                  : failed
                    ? "border-destructive/40 bg-destructive/5"
                    : "border-border bg-background/40"
              }`}
            >
              <div className="flex items-start gap-2">
                {done ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                ) : failed ? (
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                ) : unverified ? (
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                ) : running ? (
                  <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                ) : (
                  <Circle
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                      skipped ? "text-muted-foreground/30" : "text-muted-foreground/50"
                    }`}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">
                    {index + 1}. {step.title}
                    {(failed || unverified || skipped) && (
                      <span
                        className={`ml-1.5 text-[10px] font-normal ${
                          failed ? "text-destructive" : unverified ? "text-amber-500" : "text-muted-foreground"
                        }`}
                      >
                        (
                        {failed
                          ? t("codingPage.stepFailed")
                          : unverified
                            ? t("codingPage.stepUnverified")
                            : t("codingPage.stepSkipped")}
                        )
                      </span>
                    )}
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
          onClick={() => setShowRefinement(true)}
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

      {showRefinement && (
        <PlanRefinementDialog
          plan={plan}
          onSubmit={(prompt) => {
            setShowRefinement(false);
            refinementPendingRef.current = true;
            onRefine(prompt);
          }}
          onCancel={() => setShowRefinement(false)}
        />
      )}
    </div>
  );
}
