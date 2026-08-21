import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent";

/**
 * Regression coverage for the "coding agent keeps trying the same broken edit" loop:
 * the same tool error text repeating across iterations (even when OTHER calls succeed
 * in between, e.g. a read) is now detected and aborts the run with an honest note.
 *
 * The other guardrails miss this case structurally:
 *  - maxRepeatedToolCall only blocks byte-IDENTICAL calls (and only the 4th) - a slightly
 *    varied retry passes forever,
 *  - consecutiveToolFailures only counts iterations where EVERY call failed - a successful
 *    read in between resets it,
 *  - ToolErrorTracker is keyed on the exact input signature.
 * The identical FAILURE TEXT is the signal here: it is what "the model tries the same thing
 * and gets the same error" actually looks like (e.g. `edit` -> "oldString not found").
 *
 * Note on the scripted provider: after a tool-executing iteration the run loop gives the
 * model another turn to react to the tool results, so each tool iteration consumes TWO
 * scripted responses. The arrays below account for that.
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
    execute: async (input: Record<string, unknown>) => {
      if (input["action"] === "read") return { success: true, data: "file contents", error: null };
      // The edit keeps failing with the exact error from the real tool.
      return {
        success: false,
        data: null,
        error: "oldString not found in file: M:\\projekte\\ducki-node\\index.html. The text must match the file EXACTLY.",
      };
    },
  } as any);
  return agent;
}

// A short text prefix keeps the model's response non-empty and the scripted sequence
// deterministic (no empty-response recovery re-generate shifting the index).
const EDIT = 'Ich versuche den Edit. [TOOL:filesystem({"action":"edit","path":"index.html","oldString":"old","newString":"new"})]';
const READ = '[TOOL:filesystem({"action":"read","path":"index.html"})]';

// Long enough that the lightweight-mode heuristic never downgrades the run.
const LONG_INPUT =
  "Bitte arbeite diesen Auftrag vollstaendig ab und stoppe erst, wenn alles erledigt ist. " +
  "Es geht um eine mehrschrittige Aufgabe, die Erkundung, Aenderungen und Verifikation umfasst.";

describe("repeated identical tool-error guardrail", () => {
  it("aborts when the same failing edit repeats across iterations even with successful reads in between", async () => {
    // Each tool iteration consumes two scripted responses (the loop gives the model another
    // turn after tool results), so the 3rd failing iteration needs 5 edit responses. Streak
    // (capped at maxConsecutiveToolFailures = 3) trips on iteration 3 - the reads keep
    // consecutiveToolFailures from ever firing.
    const agent = buildAgent(scriptedProvider([EDIT + READ, EDIT + READ, EDIT + READ, EDIT + READ, EDIT + READ, "done"]));
    const result = await agent.run(LONG_INPUT, { agentMode: "full" });

    expect(result.iterations).toBe(3); // stopped long before the 50-iteration default
    expect(result.abortedReason).toBe("repeated_error_loop");
    expect(result.response).toContain("Abgebrochen");
    expect(result.response).toContain("identischem Tool-Fehler");
  });

  it("does not abort when the error text changes between iterations (real debugging)", async () => {
    // A counter-backed tool makes every call fail with a DIFFERENT error, so the failure
    // signature changes every iteration and the streak never grows.
    const agent = new Agent(scriptedProvider([EDIT + READ, EDIT + READ, EDIT + READ, EDIT + READ, EDIT + READ, EDIT + READ, "done"]), stubDb(), undefined, {
      enablePlanning: false,
      enableReflection: false,
      disableQualityPasses: true,
    });
    let callCounter = 0;
    agent.executor.registerTool({
      name: "filesystem",
      description: "test filesystem",
      definition: { name: "filesystem", description: "test", parameters: { type: "object", properties: {} } },
      execute: async (input: Record<string, unknown>) => {
        if (input["action"] === "read") return { success: true, data: "file contents", error: null };
        callCounter++;
        return { success: false, data: null, error: `oldString not found: variant ${callCounter}` };
      },
    } as any);

    const result = await agent.run(LONG_INPUT, { agentMode: "full" });

    expect(result.abortedReason).toBeUndefined();
    expect(result.iterations).toBe(4); // ran to the natural end, no abort
    expect(result.response).not.toContain("Abgebrochen");
  });

  it("honors the AGENT_MAX_TOOL_FAILURES setting as the streak cap", async () => {
    // Cap 2 -> streak (2) trips on the 2nd identical failing iteration (2 scripted responses
    // per iteration, so the 4th response is the 2nd iteration's second turn).
    const db = stubDb([{ key: "AGENT_MAX_TOOL_FAILURES", value: "2" }]);
    const agent = buildAgent(scriptedProvider([EDIT + READ, EDIT + READ, EDIT + READ, EDIT + READ, "done"]), db);
    const result = await agent.run(LONG_INPUT, { agentMode: "full" });

    expect(result.iterations).toBe(2);
    expect(result.abortedReason).toBe("repeated_error_loop");
    expect(result.response).toContain("Abgebrochen");
  });
});
