import type { PlanStep } from "@ducki/agent";

export type ExecutablePlanStepInput = Partial<PlanStep> & {
  tools?: string[];
  /** Legacy Plan event aliases emitted before full-fidelity PlanStep payloads. */
  duration?: number;
  parallelizable?: string[];
};

const normalizedTitle = (title: unknown): string => String(title ?? "").trim().toLowerCase();

/**
 * Restores fields omitted by older UI plan events from the authoritative persisted plan.
 * Client/live values still win because they may contain the newest status and ordering.
 */
export function restorePlanStepContracts(
  clientSteps: ExecutablePlanStepInput[],
  persistedSteps: PlanStep[]
): ExecutablePlanStepInput[] {
  const persistedById = new Map(persistedSteps.map((step) => [step.id, step]));
  const persistedByTitle = new Map(persistedSteps.map((step) => [normalizedTitle(step.title), step]));

  return clientSteps.map((clientStep) => {
    const persisted =
      (clientStep.id ? persistedById.get(clientStep.id) : undefined)
      ?? persistedByTitle.get(normalizedTitle(clientStep.title));
    if (!persisted) return clientStep;
    return { ...persisted, ...clientStep };
  });
}
