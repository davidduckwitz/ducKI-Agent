/** Paired evaluation harness. A runner must supply fresh fixtures and an independent oracle. */
export interface CodingEvaluationCase {
  id: string;
  goal: string;
  invariant: string;
}
export const CODING_EVALUATION_CASES: readonly CodingEvaluationCase[] = [
  { id: "small-fix", goal: "Repair a nullable assignment", invariant: "Targeted test passes without unrelated changes" },
  { id: "multi-file", goal: "Update an API and its consumer", invariant: "Both sides agree and integration test passes" },
  { id: "compaction", goal: "Continue a long coding task after forced compression", invariant: "Original constraints and completed steps survive" },
  { id: "repeated-failure", goal: "Repair a fault after the same verification fails twice", invariant: "Change strategy without exceeding the retry budget" },
  { id: "resume", goal: "Resume an interrupted task", invariant: "Do not redo completed work or misreport verification" },
  { id: "project-isolation", goal: "Work on two projects with conflicting conventions", invariant: "Only the current project's approved lessons are used" },
];
export interface CodingEvaluationObservation {
  completed: boolean;
  independentlyVerified: boolean;
  constraintViolations: number;
  repeatedActions: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}
export interface CodingEvaluationConfig { model: string; maxIterations: number; maxAttempts: number; repeats: number }
export async function evaluateCodingAgent(config: CodingEvaluationConfig,
  runFreshFixture: (task: CodingEvaluationCase, options: CodingEvaluationConfig & { projectLearning: boolean; repetition: number }) => Promise<CodingEvaluationObservation>,
  cases: readonly CodingEvaluationCase[] = CODING_EVALUATION_CASES) {
  if (!config.model || !Number.isInteger(config.repeats) || config.repeats < 1 || config.repeats > 20 ||
    config.maxAttempts < 1 || config.maxIterations < 1) throw new Error("Invalid evaluation budget");
  const results: Array<CodingEvaluationObservation & { caseId: string; projectLearning: boolean; repetition: number }> = [];
  for (const task of cases) for (let repetition = 0; repetition < config.repeats; repetition++) {
    // Alternate order to avoid consistently favoring a warm model/cache for one arm.
    for (const projectLearning of repetition % 2 ? [true, false] : [false, true]) {
      const observation = await runFreshFixture(task, { ...config, projectLearning, repetition });
      for (const key of ["constraintViolations", "repeatedActions", "inputTokens", "outputTokens", "durationMs"] as const) {
        if (!Number.isFinite(observation[key]) || observation[key] < 0) throw new Error(`Invalid measurement: ${key}`);
      }
      results.push({ ...observation, caseId: task.id, projectLearning, repetition });
    }
  }
  const aggregate = (enabled: boolean) => {
    const rows = results.filter(r => r.projectLearning === enabled);
    return { runs: rows.length,
      verifiedCompletionRate: rows.length ? rows.filter(r => r.completed && r.independentlyVerified && !r.constraintViolations).length / rows.length : 0,
      falseCompletionClaims: rows.filter(r => r.completed && !r.independentlyVerified).length,
      constraintViolations: rows.reduce((n, r) => n + r.constraintViolations, 0),
      repeatedActions: rows.reduce((n, r) => n + r.repeatedActions, 0),
      tokens: rows.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0),
      durationMs: rows.reduce((n, r) => n + r.durationMs, 0) };
  };
  return { config, memoryOff: aggregate(false), memoryOn: aggregate(true), results };
}
