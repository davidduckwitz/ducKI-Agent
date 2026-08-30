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
function stubDb(settings: Array<{ key: string; value: string }> = [], capturedMessages?: Array<Record<string, unknown>>) {
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => settings,
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
    getEverUsedSkills: async () => [],
    createConversation: async (data: { name: string }) => ({ id: 1, name: data.name }),
    addMessage: async (data: Record<string, unknown>) => {
      capturedMessages?.push(data);
      return { id: (capturedMessages?.length ?? 0), ...data };
    },
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

function buildAgent(provider: any, db?: any, fsExecute?: (input: any) => Promise<any>): Agent {
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
    execute: fsExecute ?? (async () => ({ success: true, data: "file contents", error: null })),
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

  it("gives a configured coding recovery turn before aborting an identical-content read loop", async () => {
    // The fifth identical read reaches the default guard. A CodingAgent can spend one
    // recovery turn instead, and this scripted model then exits without repeating the read.
    const agent = buildAgent(
      scriptedProvider([READ, READ, READ, READ, READ, "done"]),
      stubDb([{ key: "AGENT_MAX_REPEATED_TOOL_CALL", value: "20" }])
    );
    const events: any[] = [];
    const result = await agent.run(LONG_INPUT, {
      agentMode: "full",
      staleReadRecovery: { maxRecoveries: 1, requireSameContent: true },
      onEvent: (event) => events.push(event),
    });

    expect(result.iterations).toBe(6);
    expect(result.response).not.toContain("Abgebrochen");
    expect(events.some((event) => event.message.includes("Recovery"))).toBe(true);
  });

  it("steers the model to WRITE an empty file instead of repeating the read that will never change", async () => {
    // Regression: re-reading an empty (or not-yet-created) file never changes, so the generic
    // "the last reads returned the same file version" recovery text didn't tell the model what
    // was actually different about THIS loop - it kept re-reading instead of just writing the
    // file, sometimes for several whole CodingAgent macro-attempts before one happened to write
    // it. The recovery message now names the file and says WRITE it explicitly. Uses a
    // successful-but-empty read (not a failing "not found" read) because a failing read trips
    // the separate consecutive-tool-failures guardrail (default threshold 3) before the
    // stale-read-loop threshold (4) is even reached - a successful empty read is both the
    // reachable case AND what the reported run actually showed (the read tool call itself
    // succeeded; the file just had nothing useful in it).
    const capturedMessages: Array<Record<string, unknown>> = [];
    const agent = buildAgent(
      scriptedProvider([READ, READ, READ, READ, READ, "done"]),
      stubDb([{ key: "AGENT_MAX_REPEATED_TOOL_CALL", value: "20" }], capturedMessages),
      async () => ({ success: true, data: "", error: null })
    );
    await agent.startConversation({ name: "test" });
    const result = await agent.run(LONG_INPUT, {
      agentMode: "full",
      staleReadRecovery: { maxRecoveries: 1, requireSameContent: false },
    });

    expect(result.response).not.toContain("Abgebrochen");
    const recoveryMessage = capturedMessages.find(
      (m) => m["role"] === "user" && String(m["content"]).includes("READ-LOOP RECOVERY")
    );
    expect(recoveryMessage).toBeDefined();
    expect(String(recoveryMessage!["content"])).toContain("a.txt");
    expect(String(recoveryMessage!["content"])).toContain("it is empty");
    expect(String(recoveryMessage!["content"])).toContain('WRITE it now');
  });
});
