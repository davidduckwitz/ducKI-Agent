import { expect, it, vi } from "vitest";
import { evaluateCodingAgent, CODING_EVALUATION_CASES } from "../src/performance/coding-evaluation.js";
it("compares isolated memory arms with identical models and budgets and an independent oracle", async () => {
  const runner = vi.fn(async (_task, options) => ({ completed: true, independentlyVerified: options.projectLearning,
    constraintViolations: 0, repeatedActions: options.projectLearning ? 0 : 1, inputTokens: 100, outputTokens: 10, durationMs: 5 }));
  const config = { model: "test-model", maxIterations: 10, maxAttempts: 3, repeats: 2 };
  const report = await evaluateCodingAgent(config, runner, CODING_EVALUATION_CASES.slice(0, 1));
  expect(runner.mock.calls.map(c => c[1].projectLearning)).toEqual([false, true, true, false]);
  expect(runner.mock.calls.every(c => c[1].model === config.model && c[1].maxAttempts === 3)).toBe(true);
  expect(report.memoryOff.falseCompletionClaims).toBe(2);
  expect(report.memoryOn.verifiedCompletionRate).toBe(1);
  expect(report.memoryOn.tokens).toBe(220);
});
