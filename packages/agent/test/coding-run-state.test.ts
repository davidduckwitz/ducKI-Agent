import { describe, expect, it, vi } from "vitest";
import { CodingRunState } from "../src/coding/coding-run-state.js";
import { CodingFailureReflector } from "../src/coding/failure-reflector.js";

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as any;
}

describe("CodingRunState", () => {
  it("tracks repeated verifier failures and requests one reflection before non-convergence stop", () => {
    const state = new CodingRunState();

    const first = state.recordVerifyFailure("same compiler error");
    expect(first.identicalToPrevious).toBe(false);
    expect(first.identicalFailureStreak).toBe(0);
    expect(first.shouldReflect).toBe(false);
    expect(first.shouldStopForNonConvergence).toBe(false);

    const second = state.recordVerifyFailure("same compiler error");
    expect(second.identicalToPrevious).toBe(true);
    expect(second.identicalFailureStreak).toBe(1);
    expect(second.shouldReflect).toBe(true);
    expect(second.shouldStopForNonConvergence).toBe(false);

    state.markReflectionAttempted({
      diagnosis: "The previous edit did not touch the failing path.",
      avoid: ["Repeat the same edit"],
      nextActions: ["Trace the reported symbol to its definition"],
    });

    const third = state.recordVerifyFailure("same compiler error");
    expect(third.identicalFailureStreak).toBe(2);
    expect(third.shouldReflect).toBe(false);
    expect(third.shouldStopForNonConvergence).toBe(true);
    expect(third.reflection?.diagnosis).toContain("did not touch");
  });

  it("reflects on every repeat (not just the first) when given a higher identical-failure budget", () => {
    // A caller-configured AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES of 6 gives 4 non-stop
    // repeats (attempts 2-5) before the 6th identical failure triggers the stop - each of those
    // repeats should get its own reflection instead of only the very first one.
    const state = new CodingRunState(6);

    state.recordVerifyFailure("same error"); // attempt 1: first occurrence, no repeat yet
    const second = state.recordVerifyFailure("same error");
    const third = state.recordVerifyFailure("same error");
    const fourth = state.recordVerifyFailure("same error");
    const fifth = state.recordVerifyFailure("same error");
    const sixth = state.recordVerifyFailure("same error");

    expect(second.shouldReflect).toBe(true);
    expect(third.shouldReflect).toBe(true);
    expect(fourth.shouldReflect).toBe(true);
    expect(fifth.shouldReflect).toBe(true);
    expect([second, third, fourth, fifth].every((u) => !u.shouldStopForNonConvergence)).toBe(true);

    expect(sixth.identicalFailureStreak).toBe(5);
    expect(sixth.shouldStopForNonConvergence).toBe(true);
    expect(sixth.shouldReflect).toBe(false);
  });

  it("resets the identical streak when verifier output changes but keeps total failure count", () => {
    const state = new CodingRunState();
    state.recordVerifyFailure("error A");
    state.recordVerifyFailure("error A");

    const changed = state.recordVerifyFailure("error B");

    expect(changed.verifyFailures).toBe(3);
    expect(changed.identicalToPrevious).toBe(false);
    expect(changed.identicalFailureStreak).toBe(0);
    expect(changed.shouldStopForNonConvergence).toBe(false);
  });

  it("keeps file-change and journal state scoped to the run instance", () => {
    const firstRun = new CodingRunState();
    firstRun.markFileChanges(2);
    firstRun.journal.push({
      iteration: 1,
      toolName: "filesystem",
      summary: "edited src/a.ts",
      success: true,
      timestamp: new Date(0).toISOString(),
    });

    const secondRun = new CodingRunState();

    expect(firstRun.anyFileChanged).toBe(true);
    expect(firstRun.journal).toHaveLength(1);
    expect(secondRun.anyFileChanged).toBe(false);
    expect(secondRun.journal).toEqual([]);
    expect(secondRun.failureSnapshot()).toEqual({
      verifyFailures: 0,
      identicalFailureStreak: 0,
    });
  });
});

describe("CodingFailureReflector", () => {
  it("returns a compact structured diagnosis from JSON", async () => {
    const generate = vi.fn(async () => ({
      content: JSON.stringify({
        diagnosis: "The edit changed a caller, but the type error is in the exported signature.",
        avoid: ["Changing the caller again"],
        nextActions: ["Inspect the exported signature", "Run diagnostics on that file"],
      }),
      model: "test",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    }));
    const reflector = new CodingFailureReflector({ generate } as any, logger(), 1000);

    const result = await reflector.reflect({
      goal: "fix the type error",
      verifyCommand: "pnpm typecheck",
      verifyError: "error TS2322 in src/a.ts",
      previousSummary: "updated caller",
      journal: [],
    });

    expect(result).toEqual({
      diagnosis: "The edit changed a caller, but the type error is in the exported signature.",
      avoid: ["Changing the caller again"],
      nextActions: ["Inspect the exported signature", "Run diagnostics on that file"],
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[1]).toMatchObject({ temperature: 0.1, maxTokens: 500 });
    expect(generate.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(generate.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it("includes recent edit diffs and previously ruled-out approaches in the prompt", async () => {
    const generate = vi.fn(async () => ({
      content: JSON.stringify({ diagnosis: "x", avoid: [], nextActions: [] }),
      model: "test",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    }));
    const reflector = new CodingFailureReflector({ generate } as any, logger(), 1000);

    await reflector.reflect({
      goal: "fix the type error",
      verifyCommand: "pnpm typecheck",
      verifyError: "error TS2322 in src/a.ts",
      previousSummary: "updated caller",
      journal: [],
      recentEdits: [
        { path: "src/a.ts", action: "edit", before: "return x;", after: "return x satisfies number;" },
      ],
      previouslyRuledOut: ["Changing the caller again", "Changing the caller again"],
    });

    const userMessage = generate.mock.calls[0]?.[0]?.[1]?.content as string;
    expect(userMessage).toContain("Edits made in the failing attempt");
    expect(userMessage).toContain("edit src/a.ts");
    expect(userMessage).toContain("return x;");
    expect(userMessage).toContain("return x satisfies number;");
    expect(userMessage).toContain("Already ruled out by earlier reflections this run");
    // Duplicate ruled-out entries are de-duplicated before being shown to the model.
    expect(userMessage.match(/Changing the caller again/g)).toHaveLength(1);
  });

  it("degrades to undefined instead of creating a new failure mode on malformed output", async () => {
    const log = logger();
    const reflector = new CodingFailureReflector({
      generate: vi.fn(async () => ({
        content: "I think you should retry everything",
        model: "test",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      })),
    } as any, log, 1000);

    const result = await reflector.reflect({
      goal: "fix",
      verifyCommand: "test",
      verifyError: "same error",
      previousSummary: "attempted fix",
      journal: [],
    });

    expect(result).toBeUndefined();
    expect(log.debug).toHaveBeenCalled();
  });

  it("aborts the provider request on timeout and returns undefined", async () => {
    vi.useFakeTimers();
    try {
      const log = logger();
      let seenSignal: AbortSignal | undefined;
      const generate = vi.fn((_messages: unknown, options?: { signal?: AbortSignal }) => {
        seenSignal = options?.signal;
        return new Promise(() => undefined);
      });
      const reflector = new CodingFailureReflector({ generate } as any, log, 25);

      const pending = reflector.reflect({
        goal: "fix",
        verifyCommand: "test",
        verifyError: "same error",
        previousSummary: "attempted fix",
        journal: [],
      });
      await vi.advanceTimersByTimeAsync(30);

      await expect(pending).resolves.toBeUndefined();
      expect(seenSignal).toBeDefined();
      expect(seenSignal?.aborted).toBe(true);
      expect(log.warn).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
