import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent";

/**
 * The three coding execution paths must apply the documented settings consistently:
 *  - Chat plan execution (dedicated CodingAgent): per-attempt budget = CODING_AGENT_MAX_ITERATIONS_*
 *    tiers - the explicit value passed to the constructor.
 *  - Coding-area chat (regular agent + [CODING_CONTEXT]): AGENT_CODING_MAX_ITERATIONS (the shared
 *    coding cap) - the regular agent has NO explicit per-run budget of its own.
 *  - The Explorer sub-agent (dedicated, explicit maxIterations 12): keeps its own cap.
 *
 * The run loop's coding block used to force the shared cap (codingMaxIterations) over everything,
 * which silently ignored the CodingAgent tiers AND the Explorer's 12-iteration limit. This suite
 * locks the unified behavior in.
 */
function stubDb() {
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
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

/** Provider that always answers with a tool call - the run is then bounded only by maxIterations.
 *  Every response reads a DIFFERENT file, so neither the stale-read guardrail nor the repeated-call
 *  block can trip and shorten the run. */
function readLoopProvider(distinctCalls: number) {
  let index = 0;
  return {
    model: "test-model",
    generate: async () => {
      const i = index % distinctCalls;
      index++;
      return {
        content: `[TOOL:filesystem({"action":"read","path":"f${i}.txt"})]`,
        model: "test-model",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      };
    },
    generateStream: async () => ({
      content: "done",
      model: "test-model",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }),
    supportsStreaming: () => false,
  } as any;
}

function registerStubFilesystem(agent: Agent): void {
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
}

const LONG_INPUT =
  "Bitte arbeite diesen Auftrag vollstaendig ab und stoppe erst, wenn alles erledigt ist. " +
  "Es geht um eine mehrschrittige Aufgabe, die Erkundung, Aenderungen und Verifikation umfasst.";

describe("coding iteration budget unification", () => {
  it("keeps the explicit maxIterations of a dedicated agent (CodingAgent tiers / Explorer cap)", async () => {
    const agent = new Agent(readLoopProvider(10), stubDb(), undefined, {
      maxIterations: 6,
      disableQualityPasses: true, // dedicated agents (CodingAgent, Explorer) set this
      enablePlanning: false,
      enableReflection: false,
    });
    registerStubFilesystem(agent);

    const result = await agent.run(LONG_INPUT, { agentMode: "full" });

    // 6 iterations = the explicit budget, NOT the shared coding cap (default 60).
    expect(result.iterations).toBe(6);
  });

  it("applies the shared coding cap to the regular coding-area chat agent (no explicit budget)", async () => {
    // No maxIterations option - mirrors buildAgentFactory's regular agent. The [CODING_CONTEXT]
    // marker is what makes this a coding run; AGENT_CODING_MAX_ITERATIONS (default 60) applies.
    const agent = new Agent(readLoopProvider(70), stubDb(), undefined, {
      enablePlanning: false,
      enableReflection: false,
    });
    registerStubFilesystem(agent);

    const result = await agent.run(`${LONG_INPUT}\n\n[CODING_CONTEXT]\nproject=my-project`, {
      agentMode: "full",
    });

    expect(result.iterations).toBe(60);
  });
});
