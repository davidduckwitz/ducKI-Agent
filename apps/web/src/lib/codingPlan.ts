import type { Plan, PlanStep } from "../components/chat/PlanExecutionPanel";

/** Map every backend/agent status vocabulary to the one used by CodingPlanPanel. */
export function normalizeCodingPlanStepStatus(status: string | undefined): string | undefined {
  if (status === "completed") return "done";
  if (status === "running") return "in_progress";
  if (status === "blocked") return "failed";
  return status;
}

function stepKey(step: Pick<PlanStep, "id" | "title">): string {
  return step.id ? `id:${step.id}` : `title:${step.title.trim().toLowerCase()}`;
}

/**
 * Select the newer plan while retaining rich step contracts from the persisted copy. Live plan
 * events carry the freshest order/status; the DB copy is the durable source for fields omitted
 * by older event payloads (acceptance criteria, expected files, verification commands, ...).
 */
export function mergeCodingPlanSnapshots(live: Plan | null, persisted: Plan | null): Plan | null {
  if (!live) return persisted;
  if (!persisted) return live;

  const liveId = live.id ?? -1;
  const persistedId = persisted.id ?? -1;
  if (persistedId > liveId) return persisted;
  if (liveId > persistedId) return live;

  const persistedSteps = new Map((persisted.steps ?? []).map((step) => [stepKey(step), step]));
  const steps = (live.steps ?? []).map((step) => ({
    ...(persistedSteps.get(stepKey(step)) ?? {}),
    ...step,
  }));

  return {
    ...persisted,
    ...live,
    steps,
  };
}
