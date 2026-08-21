import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent";

/**
 * Regression coverage for the "agent hangs repeating the same read-only calls" loop:
 * the run loop now aborts (with an honest note) once several consecutive iterations
 * re-issue the EXACT SAME read-only call set without any mutation in between.
 *
 * The other guardrails cannot catch this: maxRepeatedToolCall only blocks byte-identical
 * single calls (and only the 4th), and maxConsecutiveToolFailures only counts iterations
 * where every call FAILED - a model re-reading the same file succeeds every time.
 */
function stubDb(settings: Array<{ key: string; value: string }> = []) {
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => settings,
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
    getEverUsedSkills: async () => [],
    createConversation: async (data: { name: string }) => ({ id: 1, name: data.name }),
  };
  return new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as any;
}

/** Provider that hands back a scripted sequence of responses, one per generate call. */
function scriptedProvider(contents: string[]) {
  let index = 0;
  const next = () => {
    const content = contents[Math.min(index, contents.length - 1)] ?? "done";
    index++;
    return {
      content,
      model: "test-model",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    };
  };
  return {
    model: "test-model",
    generate: async () => next(),
    generateStream: async () => next(),
    supportsStreaming: () => false,
  } as any;
}

function buildAgent(provider: any, db?: any): Agent {
  const agent = new Agent(provider, db ?? stubDb(), undefined, {
    enablePlanning: false,
    enableReflection: false,
    disableQualityPasses: true,
  });
  agent.executor.registerTool({
    name: "filesystem",
    description: "test filesystem",
    definition: {
      name: "filesystem",
      description: "test",
      parameters: { type: "object", properties: {} },
    },
    execute: async () => ({ success: true, data: "file contents", error: null }),
  } as any);
  return agent;
}

const READ = '[TOOL:filesystem({"action":"read","path":"a.txt"})]';
const WRITE = '[TOOL:filesystem({"action":"write","path":"a.txt","content":"x"})]';
const READ_B = '[TOOL:filesystem({"action":"read","path":"b.txt"})]';

// Long enough that the lightweight-mode heuristic never downgrades the run.
const LONG_INPUT =
  "Bitte arbeite diesen Auftrag vollstaendig ab und stoppe erst, wenn alles erledigt ist. " +
  "Es geht um eine mehrschrittige Aufgabe, die Erkundung, Aenderungen und Verifikation umfasst.";

describe("stale read-only loop guardrail", () => {
  it("aborts after N consecutive identical read-only iterations instead of burning the iteration budget", async () => {
    // 6 identical reads in a row: streak reaches the threshold (4) on iteration 5.
    const agent = buildAgent(scriptedProvider([READ, READ, READ, READ, READ, READ, "done"]));
    const result = await agent.run(LONG_INPUT, { agentMode: "full" });

    expect(result.iterations).toBe(5); // stopped long before the 50-iteration default
    expect(result.response).toContain("Abgebrochen");
    expect(result.response).toContain("kein Fortschritt erkennbar");
  });

  it("does not abort when the read set changes between iterations (normal exploration)", async () => {
    // read a.txt, read a.txt, read a.txt, then switch to b.txt: switching resets the streak.
    const agent = buildAgent(scriptedProvider([READ, READ, READ, READ_B, READ_B, READ_B, "done"]));
    const result = await agent.run(LONG_INPUT, { agentMode: "full" });

    expect(result.iterations).toBe(7); // ran to the natural end
    expect(result.response).not.toContain("Abgebrochen");
  });

  it("does not abort when mutations happen between reads (edit -> verify flow)", async () => {
    // read -> write -> read -> write: every write is a mutation and resets the streak.
    const agent = buildAgent(scriptedProvider([READ, WRITE, READ, WRITE, READ, WRITE, "done"]));
    const result = await agent.run(LONG_INPUT, { agentMode: "full" });

    expect(result.iterations).toBe(7);
    expect(result.response).not.toContain("Abgebrochen");
  });

  it("honors the AGENT_STALE_READ_STREAK setting from the database (settings page value)", async () => {
    // threshold 2 (as configured via /settings) -> abort on the 3rd identical read iteration,
    // where the streak (2) reaches the threshold.
    const db = stubDb([{ key: "AGENT_STALE_READ_STREAK", value: "2" }]);
    const agent = buildAgent(scriptedProvider([READ, READ, READ, READ, "done"]), db);
    const result = await agent.run(LONG_INPUT, { agentMode: "full" });

    expect(result.iterations).toBe(3); // sooner than the default threshold of 4
    expect(result.response).toContain("Abgebrochen");
    expect(result.response).toContain("kein Fortschritt erkennbar");
  });
});
