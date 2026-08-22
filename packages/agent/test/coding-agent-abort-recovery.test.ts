import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * Regression coverage for "the coding agent just stops": CodingAgent.run() never looked at
 * Agent.run()'s AgentRunResult.abortedReason at all, so a guardrail-aborted attempt (e.g. the
 * stale-read-loop guardrail cutting off a model that got stuck re-reading the same file) was
 * treated exactly like a normal completion. Two distinct fixes:
 *  - a recoverable stall (stale_read_loop / repeated_error_loop / consecutive_tool_failures)
 *    now retries with a corrective follow-up instead of silently ending the run.
 *  - an explicit user_stopped abort now ends the run immediately instead of risking another
 *    attempt starting as if nothing happened.
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

function scriptedProvider(contents: string[]) {
  let index = 0;
  const next = () => {
    const content = contents[Math.min(index, contents.length - 1)] ?? "Fertig.";
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

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
});

describe("CodingAgent recovers from a guardrail-aborted attempt", () => {
  it("retries with a corrective follow-up after a recoverable stall (stale_read_loop)", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-abort-retry-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider(["irrelevant - agent.run is mocked below"]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const innerAgent = (codingAgent as any).agent;
    const seenPrompts: string[] = [];
    let callCount = 0;
    innerAgent.run = (async (prompt: string) => {
      callCount++;
      seenPrompts.push(prompt);
      if (callCount === 1) {
        return {
          response: "_Abgebrochen: 4 Iterationen in Folge haben nur identische Lese-Vorgaenge wiederholt._",
          iterations: 5,
          toolsUsed: ["filesystem"],
          abortedReason: "stale_read_loop",
        };
      }
      return { response: "Fertig.", iterations: 1, toolsUsed: [] };
    }) as typeof innerAgent.run;

    const result = await codingAgent.run("build a static page", { maxAttempts: 3 });

    expect(callCount).toBe(2);
    expect(result.attempts).toBe(2);
    // The second attempt's prompt must carry the corrective instruction derived from the abort.
    expect(seenPrompts[1]).toContain("was aborted");
    expect(seenPrompts[1]).toContain("do NOT repeat that exact action again");
  });

  it("stops immediately on an explicit user_stopped abort instead of starting another attempt", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-abort-stop-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider(["irrelevant - agent.run is mocked below"]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const innerAgent = (codingAgent as any).agent;
    let callCount = 0;
    innerAgent.run = (async () => {
      callCount++;
      return { response: "stopped mid-way", iterations: 1, toolsUsed: [], abortedReason: "user_stopped" };
    }) as typeof innerAgent.run;

    const result = await codingAgent.run("build a static page", { maxAttempts: 3 });

    expect(callCount).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.success).toBe(false);
  });
});
