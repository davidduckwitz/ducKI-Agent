import { describe, expect, it, vi } from "vitest";
import {
  FailureAwareCodingAgent,
  createCodingAgent,
} from "../src/index.js";

function stubDb(settings: Record<string, string> = {}) {
  let nextId = 1;
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async (key: string) => settings[key],
    createConversation: async (data: { name: string }) => ({ id: nextId++, name: data.name }),
  };
  return new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as any;
}

function mainProvider() {
  const response = {
    content: "done",
    model: "main-test-model",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
  return {
    model: "main-test-model",
    generate: vi.fn(async () => response),
    generateStream: vi.fn(async () => response),
    supportsStreaming: () => false,
  } as any;
}

function reflectionProvider() {
  return {
    model: "reflection-test-model",
    generate: vi.fn(async () => ({
      content: JSON.stringify({
        diagnosis: "The previous edit did not affect the code path reported by verification.",
        avoid: ["Repeat the same edit"],
        nextActions: ["Trace the failing symbol from the verifier output"],
      }),
      model: "reflection-test-model",
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    })),
    generateStream: vi.fn(),
    supportsStreaming: () => false,
  } as any;
}

describe("FailureAwareCodingAgent", () => {
  it("the public createCodingAgent factory now returns the compatible failure-aware subclass", () => {
    const agent = createCodingAgent(mainProvider(), stubDb(), undefined, {});
    expect(agent).toBeInstanceOf(FailureAwareCodingAgent);
  });

  it("reflects exactly once after the same deterministic verify error repeats and injects it into the next attempt", async () => {
    const reflector = reflectionProvider();
    const codingAgent = new FailureAwareCodingAgent(mainProvider(), stubDb(), undefined, {
      maxAttempts: 3,
      explorerProvider: reflector,
    });
    const innerAgent = (codingAgent as any).agent;
    const seenPrompts: string[] = [];
    const realRun = innerAgent.run.bind(innerAgent);
    innerAgent.run = (async (prompt: string, options: any = {}) => {
      seenPrompts.push(prompt);
      return realRun(prompt, options);
    }) as typeof innerAgent.run;
    innerAgent.executor.execute = vi.fn(async () => ({
      success: false,
      data: null,
      error: "error TS2322: same deterministic failure",
    }));

    const result = await codingAgent.run("fix the type error", {
      maxAttempts: 3,
      verifyCommand: "pnpm typecheck",
    });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
    expect(reflector.generate).toHaveBeenCalledTimes(1);
    expect(seenPrompts).toHaveLength(3);
    expect(seenPrompts[0]).not.toContain("Failure reflection");
    expect(seenPrompts[1]).not.toContain("Failure reflection");
    expect(seenPrompts[2]).toContain("Failure reflection");
    expect(seenPrompts[2]).toContain("previous edit did not affect the code path");
    expect(seenPrompts[2]).toContain("Trace the failing symbol");
  });

  it("reflects on every repeat when AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES raises the budget, ruling out repeated avoid hints", async () => {
    const reflector = reflectionProvider();
    const codingAgent = new FailureAwareCodingAgent(
      mainProvider(),
      stubDb({ AGENT_CODING_MAX_IDENTICAL_VERIFY_FAILURES: "6" }),
      undefined,
      { maxAttempts: 6, explorerProvider: reflector }
    );
    const innerAgent = (codingAgent as any).agent;
    innerAgent.executor.execute = vi.fn(async () => ({
      success: false,
      data: null,
      error: "error TS2322: same deterministic failure",
    }));

    const result = await codingAgent.run("fix the type error", {
      maxAttempts: 6,
      verifyCommand: "pnpm typecheck",
    });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(6);
    // Attempts 2-5 each get a fresh reflection (attempt 1 has no prior failure to compare against,
    // attempt 6 is the stop attempt itself) - 4 calls, not the single one a threshold of 3 allows.
    expect(reflector.generate).toHaveBeenCalledTimes(4);

    // The second reflection call onward should see the first reflection's "avoid" hint listed as
    // already ruled out, so it doesn't just re-suggest the same dead end.
    const secondCallMessage = reflector.generate.mock.calls[1]?.[0]?.[1]?.content as string;
    expect(secondCallMessage).toContain("Already ruled out by earlier reflections this run");
    expect(secondCallMessage).toContain("Repeat the same edit");
  });

  it("does not spend a reflection call when verifier errors keep changing", async () => {
    const reflector = reflectionProvider();
    const codingAgent = new FailureAwareCodingAgent(mainProvider(), stubDb(), undefined, {
      maxAttempts: 3,
      explorerProvider: reflector,
    });
    const innerAgent = (codingAgent as any).agent;
    let verifyCall = 0;
    innerAgent.executor.execute = vi.fn(async () => {
      verifyCall++;
      return {
        success: false,
        data: null,
        error: `different deterministic failure #${verifyCall}`,
      };
    });

    const result = await codingAgent.run("fix the changing errors", {
      maxAttempts: 3,
      verifyCommand: "pnpm typecheck",
    });

    expect(result.attempts).toBe(3);
    expect(reflector.generate).not.toHaveBeenCalled();
  });

  it("does not reflect on the happy path", async () => {
    const reflector = reflectionProvider();
    const codingAgent = new FailureAwareCodingAgent(mainProvider(), stubDb(), undefined, {
      explorerProvider: reflector,
    });
    const innerAgent = (codingAgent as any).agent;
    innerAgent.executor.execute = vi.fn(async () => ({ success: true, data: "ok" }));

    const result = await codingAgent.run("make a small safe change", {
      verifyCommand: "pnpm typecheck",
      // This test isolates reflection behavior and stubs every executor call, so no real
      // filesystem mutation can be observed. Opt out of the execution contract explicitly;
      // mutation-required behavior is covered by coding-agent-checklist-grounding.test.ts.
      mutationExpected: false,
      existingPlan: {
        goal: "exercise the happy-path verifier",
        planType: "coding",
        estimatedComplexity: "low",
        steps: [],
      } as any,
    });

    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(reflector.generate).not.toHaveBeenCalled();
  });
});
