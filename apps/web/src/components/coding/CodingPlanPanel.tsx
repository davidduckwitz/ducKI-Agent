import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Circle, ListChecks, Loader2, Play, Sparkles } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { parseMarkdownToPlan } from "../../lib/parseMarkdownToPlan";
import { findLatestChecklist, firstOpenStepIndex, resolveStepStatus } from "../../lib/planChecklist";
import { findLatestPhaseProgress, CODING_PHASES, CODING_PHASE_LABEL, type CodingPhase } from "../../lib/planPhase";
import { useSettings, readFlag, readNumber } from "../../lib/useSettings";
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
}: {
  messages: RenderedChatMessage[];
  conversationId?: number;
  isLoading: boolean;
  overridePlan?: Plan | null;
  onExecutePlan?: (plan: Plan) => Promise<void>;
}) {
  const { t } = useI18n();
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRefinement, setShowRefinement] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [planHistory, setPlanHistory] = useState<Plan[]>([]);
  // A plan that came back from POST /plans/refine (see PlanRefinementDialog) - takes priority
  // over a plan derived from messages/handoff since it's the most recently reviewed version.
  const [refinedPlan, setRefinedPlan] = useState<Plan | null>(null);
  const settingsQuery = useSettings();
  const autoExecuteEnabled = readFlag(settingsQuery.data, "PLAN_MODE_AUTO_EXECUTE");
  const codingTimeoutMs = readNumber(settingsQuery.data, "CODING_AGENT_TIMEOUT_MS", 1_800_000);

  const { plan: derivedPlan } = useMemo<{ plan: Plan | null; planIndex: number }>(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (!msg || msg.eventType !== "plan" || !msg.eventData) continue;
      const raw = msg.eventData as Record<string, unknown>;
      const data = {
        ...raw,
        ...(raw["id"] === undefined && Number.isFinite(Number(raw["planId"])) ? { id: Number(raw["planId"]) } : {}),
        ...(raw["version"] === undefined && Number.isFinite(Number(raw["planVersion"])) ? { version: Number(raw["planVersion"]) } : {}),
      } as unknown as Plan;
      if (data.goal && Array.isArray(data.steps) && data.steps.length > 0) return { plan: data, planIndex: i };
      // Some planners only emit markdown - reuse the chat page's parser for those.
      if (typeof data.markdown === "string") {
        const parsed = parseMarkdownToPlan(data.markdown);
        if (parsed) return { plan: parsed, planIndex: i };
      }
    }
    return { plan: null, planIndex: -1 };
  }, [messages]);

  // A refined plan (just returned by POST /plans/refine) takes priority; otherwise prefer a
  // plan from this conversation's messages; fall back to a plan handed over from the chat page
  // (which lives in a different conversation).
  const plan = refinedPlan ?? derivedPlan ?? overridePlan ?? null;

  useEffect(() => {
    if (!conversationId) return;
    let active = true;
    void api.plans.list(conversationId).then((items) => {
      if (active) setPlanHistory(items as Plan[]);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [conversationId, refinedPlan?.id]);

  useEffect(() => {
    if (derivedPlan?.id && refinedPlan?.parentPlanId !== derivedPlan.id && (derivedPlan.version ?? 0) > (refinedPlan?.version ?? 0)) {
      setRefinedPlan(null);
    }
  }, [derivedPlan?.id, derivedPlan?.version]);

  const latestRun = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const data = messages[i]?.eventData;
      if (data?.["plan_event"] !== "run_status" || typeof data["runId"] !== "string") continue;
      if (plan?.id !== undefined && Number(data["planId"]) !== plan.id) continue;
      return data;
    }
    return undefined;
  }, [messages, plan?.id]);
  const eventScope: { runId?: string; planId?: number } | undefined = latestRun ? {
    runId: String(latestRun["runId"]),
    ...(Number.isFinite(Number(latestRun["planId"])) ? { planId: Number(latestRun["planId"]) } : {}),
  } : plan?.id !== undefined ? { planId: plan.id } : undefined;
  const completionEvidence = latestRun?.["completionEvidence"] as { changedFiles?: string[]; openChecklistItems?: string[] } | undefined;

  // Real per-step state from the agent's own checklist (see lib/planChecklist for why this
  // replaced a tool-call counter, and why the logic lives in a testable module).
  const checklist = useMemo(() => findLatestChecklist(messages, eventScope), [messages, eventScope?.runId, eventScope?.planId]);

  // The phase the agent declares it is in (see lib/planPhase). This is the same state the
  // phase-lock hook steers by, surfaced so the user can see whether the agent is exploring,
  // planning, editing, verifying or reporting - not just "a spinner somewhere".
  const phaseProgress = useMemo(() => findLatestPhaseProgress(messages, eventScope), [messages, eventScope?.runId, eventScope?.planId]);

  // Attempt / budget context from the latest iteration event, so a long run shows
  // "Versuch 2/3" instead of an unqualified "Wird ausgeführt" while it is retrying.
  const latestIteration = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.eventType === "iteration") return messages[i];
    }
    return undefined;
  }, [messages]);
  const attempt = typeof latestIteration?.eventData?.["attempt"] === "number"
    ? (latestIteration.eventData["attempt"] as number)
    : undefined;
  const maxAttempts = typeof latestIteration?.eventData?.["maxAttempts"] === "number"
    ? (latestIteration.eventData["maxAttempts"] as number)
    : undefined;

  const steps = plan?.steps ?? [];
  const statusOf = (step: { id?: string; title: string }, index: number) => resolveStepStatus(checklist, step, index);
  const runningIndex = useMemo(() => firstOpenStepIndex(checklist, steps), [checklist, steps]);
  const doneCount = checklist?.doneCount ?? 0;

  const formatBudget = (ms: number): string => {
    const minutes = Math.round(ms / 60000);
    return minutes >= 1 ? `${minutes} Min` : `${Math.round(ms / 1000)} s`;
  };

  const execute = async (planToExecute: Plan | null = plan) => {
    if (!planToExecute) return;
    setError(null);
    setExecuting(true);
    try {
      if (onExecutePlan) {
        // Robust path: parent guarantees a coding project + conversation exist and
        // passes the project slug through so files land in the project sandbox.
        await onExecutePlan(planToExecute);
      } else {
        await api.plans.execute(planToExecute.id, {
          goal: planToExecute.goal,
          steps: planToExecute.steps ?? [],
          markdown: planToExecute.markdown,
          conversationId,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
    }
  };

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
          {plan.version && <span className="chip">V{plan.version}</span>}
          {latestRun && <span className="chip">{String(latestRun["status"] ?? "running")}</span>}
          {planHistory.length > 1 && <span className="chip" title="Gespeicherte Planversionen">{planHistory.length} Versionen</span>}
          {planHistory.length > 1 && (
            <select
              className="h-6 rounded border border-border bg-background px-1 text-[10px]"
              value={plan.id ?? ""}
              onChange={(event) => {
                const selected = planHistory.find((item) => item.id === Number(event.target.value));
                if (selected) setRefinedPlan(selected);
              }}
              aria-label="Planversion auswählen"
            >
              {planHistory.map((item) => <option key={item.id} value={item.id}>V{item.version ?? 1} · {item.status ?? "draft"}</option>)}
            </select>
          )}
          {isLoading && (
            <span className="chip text-amber-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("codingPage.planExecuting")}
            </span>
          )}
          {isLoading && typeof attempt === "number" && (
            <span className="chip">
              {t("codingPage.planAttempt")}: {attempt}/{maxAttempts ?? attempt}
            </span>
          )}
          <span className="chip" title={t("codingPage.planTimeoutHint")}>
            {formatBudget(codingTimeoutMs)}
          </span>
        </div>

        {/* Phase bar: Explore → Plan → Edit → Verify → Report. Only rendered once a phase
            event exists, so a fresh plan without a run shows no phases instead of a fake one. */}
        {(phaseProgress.current !== undefined || phaseProgress.completed.size > 0 || phaseProgress.failed.size > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {CODING_PHASES.map((phase: CodingPhase, index) => {
              const isCurrent = phaseProgress.current === phase;
              const isDone = phaseProgress.completed.has(phase);
              const isFailed = phaseProgress.failed.has(phase);
              return (
                <span key={phase} className="flex items-center gap-1">
                  {index > 0 && <span className="text-[10px] text-muted-foreground">›</span>}
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      isCurrent
                        ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                        : isDone
                          ? "bg-emerald-500/10 text-emerald-600"
                          : isFailed
                            ? "bg-destructive/10 text-destructive"
                            : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isCurrent && <Loader2 className="mr-0.5 inline h-2.5 w-2.5 animate-spin" />}
                    {isDone && <CheckCircle2 className="mr-0.5 inline h-2.5 w-2.5" />}
                    {CODING_PHASE_LABEL[phase]}
                  </span>
                </span>
              );
            })}
          </div>
        )}
        {completionEvidence && (
          <div className="mt-2 rounded border border-border bg-background/40 p-2 text-[10px] text-muted-foreground">
            {completionEvidence.changedFiles?.length ? <div>Geänderte Dateien: {completionEvidence.changedFiles.join(", ")}</div> : <div>Keine Dateiänderung nachgewiesen.</div>}
            {completionEvidence.openChecklistItems?.length ? <div className="mt-1 text-amber-500">Offen: {completionEvidence.openChecklistItems.join(", ")}</div> : null}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {doneCount > 0 && (
          <button type="button" className="mb-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setShowCompleted((value) => !value)}>
            {showCompleted ? "Erledigte Schritte einklappen" : `Erledigte Schritte anzeigen (${doneCount})`}
          </button>
        )}
        {steps.map((step, index) => {
          const status = statusOf(step, index);
          const done = status === "done";
          const failed = status === "failed";
          const unverified = status === "unverified";
          const skipped = status === "skipped";
          // "in_progress" is the agent's own "I am working on this NOW" signal (the todo tool
          // says to mark a step in_progress before starting it). Prefer it; fall back to the
          // positional guess only when the model never marks in_progress.
          const inProgress = status === "in_progress";
          const running = isLoading && !done && !failed && !skipped && (inProgress || index === runningIndex);
          if (done && !showCompleted) return null;

          return (
            <div
              key={step.id ?? `${step.title}-${index}`}
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
                  {(step.toolsNeeded ?? step.tools)?.length ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {(step.toolsNeeded ?? step.tools ?? []).map((tool) => (
                        <span key={tool} className="chip">
                          {tool}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {step.acceptanceCriteria?.length ? (
                    <div className="mt-1 text-[10px] text-muted-foreground">Kriterien: {step.acceptanceCriteria.join(" · ")}</div>
                  ) : null}
                  {step.expectedFiles?.length ? (
                    <div className="mt-1 text-[10px] text-muted-foreground">Dateien: {step.expectedFiles.join(", ")}</div>
                  ) : null}
                  {step.verificationCommands?.length ? (
                    <div className="mt-1 font-mono text-[10px] text-muted-foreground">Prüfung: {step.verificationCommands.join(" && ")}</div>
                  ) : null}
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
          {doneCount > 0 ? "Offene Schritte ausführen" : t("codingPage.executePlan")}
        </button>
      </div>

      {showRefinement && (
        <PlanRefinementDialog
          plan={{ ...plan, conversationId: plan.conversationId ?? conversationId }}
          onRefined={(newPlan) => {
            setShowRefinement(false);
            setRefinedPlan(newPlan);
            // PLAN_MODE_AUTO_EXECUTE: skip the manual "Umsetzen" click once a refinement
            // completes. Passed explicitly (not read from state) because setRefinedPlan above
            // hasn't re-rendered yet - `plan` in this closure would still be the old one.
            if (autoExecuteEnabled) void execute(newPlan);
          }}
          onCancel={() => setShowRefinement(false)}
        />
      )}
    </div>
  );
}
