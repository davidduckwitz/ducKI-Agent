import { describe, it, expect, vi } from "vitest";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * Regression coverage for two "the coding agent gets stuck" mitigations:
 *  - the CodingAgent-level timeoutMs budget used to only be checked BETWEEN attempts; a single
 *    attempt (up to maxIterations tool-call rounds) could blow through the whole budget since
 *    nothing enforced a ceiling on it. Fixed by passing the remaining budget as
 *    AgentRunOptions.timeoutMsOverride, which Agent.run() already turns into a real,
 *    abort-backed timeout.
 *  - a verify failure that repeats with the EXACT same error text across attempts means the
 *    model's edit had zero effect - retrying blind for the full maxAttempts budget just wastes
 *    time. Fixed by bailing early (and telling the model, before that, that its last change did
 *    nothing) once the same failure repeats 3 times in a row.
 */
function stubDb() {
  let nextId = 1;
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
    createConversation: async (data: { name: string }) => ({ id: nextId++, name: data.name }),
  };
  return new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as any;
}

function stubProvider() {
  const response = { content: "done", model: "test-model", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  return {
    model: "test-model",
    generate: async () => response,
    generateStream: async () => response,
    supportsStreaming: () => false,
  } as any;
}

describe("CodingAgent per-attempt timeout budget", () => {
  it("passes the remaining deadline as timeoutMsOverride to each attempt", async () => {
    const codingAgent = new CodingAgent(stubProvider(), stubDb(), undefined, {});
    const innerAgent = (codingAgent as any).agent;
    const seenOverrides: (number | undefined)[] = [];
    const realRun = innerAgent.run.bind(innerAgent);
    innerAgent.run = (async (prompt: string, options: any = {}) => {
      seenOverrides.push(options.timeoutMsOverride);
      return realRun(prompt, options);
    }) as typeof innerAgent.run;

    await codingAgent.run("do the thing", { timeoutMs: 60000 });

    expect(seenOverrides).toHaveLength(1);
    expect(seenOverrides[0]).toBeGreaterThan(0);
    expect(seenOverrides[0]).toBeLessThanOrEqual(60000);
  });

  it("omits timeoutMsOverride entirely when no timeoutMs budget was given", async () => {
    const codingAgent = new CodingAgent(stubProvider(), stubDb(), undefined, {});
    const innerAgent = (codingAgent as any).agent;
    const seenOverrides: (number | undefined)[] = [];
    const realRun = innerAgent.run.bind(innerAgent);
    innerAgent.run = (async (prompt: string, options: any = {}) => {
      seenOverrides.push(options.timeoutMsOverride);
      return realRun(prompt, options);
    }) as typeof innerAgent.run;

    await codingAgent.run("do the thing", {});

    expect(seenOverrides).toEqual([undefined]);
  });
});

describe("CodingAgent non-converging retry detection", () => {
  it("bails early after the same verify error repeats 3 times in a row, without exhausting maxAttempts", async () => {
    const codingAgent = new CodingAgent(stubProvider(), stubDb(), undefined, { maxAttempts: 5 });
    const innerAgent = (codingAgent as any).agent;
    (innerAgent.executor as any).execute = async () => ({
      success: false,
      data: null,
      error: "SyntaxError: unexpected token on line 12",
    });

    const result = await codingAgent.run("do the thing", { maxAttempts: 5, verifyCommand: "some-check" });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3); // stopped after the 3rd identical failure, not all 5
    expect(result.summary).toContain("attempts in a row produced the exact same verification error");
  });

  it("keeps retrying normally when the verify error changes between attempts", async () => {
    const codingAgent = new CodingAgent(stubProvider(), stubDb(), undefined, { maxAttempts: 3 });
    const innerAgent = (codingAgent as any).agent;
    let call = 0;
    (innerAgent.executor as any).execute = async () => {
      call++;
      return { success: false, data: null, error: `different error #${call}` };
    };

    const result = await codingAgent.run("do the thing", { maxAttempts: 3, verifyCommand: "some-check" });

    expect(result.attempts).toBe(3); // ran the full budget - no early bail, errors kept differing
    expect(result.summary).not.toContain("attempts in a row produced the exact same verification error");
  });

  it("tells the model its previous edit had no effect when a failure repeats once", async () => {
    // maxAttempts:3 so there IS a next attempt to carry the emphatic note into - with only 2
    // attempts, the 2nd (and last) identical failure's note would have nowhere left to go.
    const codingAgent = new CodingAgent(stubProvider(), stubDb(), undefined, { maxAttempts: 3 });
    const innerAgent = (codingAgent as any).agent;
    const seenPrompts: string[] = [];
    const realRun = innerAgent.run.bind(innerAgent);
    innerAgent.run = (async (prompt: string, options: any = {}) => {
      seenPrompts.push(prompt);
      return realRun(prompt, options);
    }) as typeof innerAgent.run;
    (innerAgent.executor as any).execute = async () => ({
      success: false,
      data: null,
      error: "same error every time",
    });

    await codingAgent.run("do the thing", { maxAttempts: 3, verifyCommand: "some-check" });

    // Attempt 1 has nothing to compare against yet; attempt 2 repeats attempt 1's error, so
    // attempt 3's prompt (built from attempt 2's outcome) should carry the emphatic note.
    expect(seenPrompts).toHaveLength(3);
    expect(seenPrompts[2]).toContain("EXACT SAME error");
    expect(seenPrompts[2]).toContain("had NO effect");
  });
});
