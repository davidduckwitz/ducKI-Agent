import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent";
import { CodingAgent } from "../src/coding/coding-agent";
import type { RunJournalEntry } from "../src/config/interfaces_types";

/**
 * Regression coverage for carrying the Run Journal forward across CodingAgent's own
 * plan->verify->iterate attempts. Each attempt is a separate agent.run() call on the SAME
 * underlying Agent/conversation; before this fix, runLoop always started a fresh empty
 * runJournal per call, so a retry after a failed verify lost the record of what earlier
 * attempts already did. Fixed via AgentRunOptions.initialRunJournal (seeds runLoop's journal)
 * and AgentRunResult.runJournal (returns its final state so the caller can carry it forward).
 */
/**
 * A full agent.run() touches many optional DatabaseService methods (memory pruning, dynamic
 * tools, settings, ...) well beyond what this test cares about. A Proxy that resolves any
 * unlisted method to an async no-op avoids chasing each one individually while keeping the
 * few methods this test's flow actually depends on (conversation creation) precisely defined.
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

function stubProvider(content: string) {
  const response = {
    content,
    model: "test-model",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
  return {
    model: "test-model",
    generate: async () => response,
    generateStream: async () => response,
    supportsStreaming: () => false,
  } as any;
}

describe("AgentRunOptions.initialRunJournal / AgentRunResult.runJournal", () => {
  it("a run with no seed and no tool calls returns an empty journal", async () => {
    const agent = new Agent(stubProvider("Nothing to do here."), stubDb(), undefined, {
      enablePlanning: false,
      enableReflection: false,
    });
    const result = await agent.run("say hello");
    expect(result.runJournal).toEqual([]);
  });

  it("a seeded journal survives a run that makes no new tool calls", async () => {
    const agent = new Agent(stubProvider("Nothing to do here."), stubDb(), undefined, {
      enablePlanning: false,
      enableReflection: false,
    });
    const seed: RunJournalEntry[] = [
      { iteration: 1, toolName: "filesystem", summary: "wrote plugin.json", success: true },
    ];
    const result = await agent.run("say hello", { initialRunJournal: seed });
    expect(result.runJournal).toEqual(seed);
  });
});

describe("CodingAgent carries the journal across its own attempts", () => {
  it("passes attempt N's returned journal as attempt N+1's seed, across a real verify-triggered retry", async () => {
    const seenSeeds: (RunJournalEntry[] | undefined)[] = [];
    const injectedJournals: RunJournalEntry[][] = [
      [{ iteration: 1, toolName: "filesystem", summary: "wrote plugin.json", success: true }],
      [
        { iteration: 1, toolName: "filesystem", summary: "wrote plugin.json", success: true },
        { iteration: 2, toolName: "filesystem", summary: "fixed tools/foo.tool.json", success: true },
      ],
    ];

    const codingAgent = new CodingAgent(stubProvider("done"), stubDb(), undefined, { maxAttempts: 2 });
    const innerAgent = (codingAgent as any).agent as Agent;
    // Stub out the underlying Agent's run() entirely: we're verifying CodingAgent's own
    // seed-in / carry-forward wiring (does it pass attempt N's returned journal as attempt
    // N+1's initialRunJournal?), not runLoop's seeding mechanism itself (covered above).
    let call = 0;
    innerAgent.run = (async (_prompt: string, options: any = {}) => {
      seenSeeds.push(options.initialRunJournal ? [...options.initialRunJournal] : undefined);
      const journal = injectedJournals[call];
      call++;
      return { response: "done", iterations: 1, toolsUsed: [], runJournal: journal };
    }) as typeof innerAgent.run;
    // First attempt's verify fails (forces a retry), second attempt's succeeds.
    let execCall = 0;
    (innerAgent.executor as any).execute = async () => {
      execCall++;
      return execCall === 1 ? { success: false, data: null, error: "verify failed" } : { success: true, data: "ok" };
    };

    const result = await codingAgent.run("do the thing", { maxAttempts: 2, verifyCommand: "some-check" });

    expect(result.attempts).toBe(2);
    expect(seenSeeds).toHaveLength(2);
    expect(seenSeeds[0]).toEqual([]); // first attempt: nothing to seed yet
    expect(seenSeeds[1]).toEqual(injectedJournals[0]); // second attempt: seeded with attempt 1's journal
  });
});
