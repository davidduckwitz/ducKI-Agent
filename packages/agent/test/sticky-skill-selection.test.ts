import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent";

/**
 * With stickySkillSelection, a second run() call on the SAME Agent instance must reuse the
 * skill selection computed on the first call instead of re-running the scoring/BFS/disk-read
 * work - see AgentOptions.stickySkillSelection. resetSkillSelectionCache() must force a fresh
 * selection on the next call (e.g. CodingAgent calling it at the top of its own run(), once per
 * goal, not once per attempt).
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

function stubProvider() {
  const response = { content: "Fertig.", model: "test-model", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  return {
    model: "test-model",
    generate: async () => response,
    generateStream: async () => response,
    supportsStreaming: () => false,
  } as any;
}

async function runAndCollectEvents(agent: Agent, prompt: string): Promise<Array<{ type: string; message: string }>> {
  const events: Array<{ type: string; message: string }> = [];
  await agent.run(prompt, { onEvent: async (evt: any) => { events.push({ type: evt.type, message: evt.message }); } });
  return events;
}

describe("Agent stickySkillSelection", () => {
  it("reuses the first run's skill selection on a second run(), and re-selects after reset", async () => {
    const agent = new Agent(stubProvider(), stubDb(), undefined, {
      enablePlanning: false,
      enableReflection: false,
      stickySkillSelection: true,
    });
    await agent.startConversation({ name: "test" });

    const first = await runAndCollectEvents(agent, "do something coding related");
    expect(first.some((e) => e.message === "Skill behavior controls applied")).toBe(true);
    expect(first.some((e) => e.message === "Skills aus vorherigem Versuch wiederverwendet")).toBe(false);

    const second = await runAndCollectEvents(agent, "do something else in the same task");
    expect(second.some((e) => e.message === "Skills aus vorherigem Versuch wiederverwendet")).toBe(true);
    expect(second.some((e) => e.message === "Skill behavior controls applied")).toBe(false);

    agent.resetSkillSelectionCache();
    const third = await runAndCollectEvents(agent, "a brand new task");
    expect(third.some((e) => e.message === "Skill behavior controls applied")).toBe(true);
    expect(third.some((e) => e.message === "Skills aus vorherigem Versuch wiederverwendet")).toBe(false);
  });

  it("without stickySkillSelection, every run() re-selects (default behavior unchanged)", async () => {
    const agent = new Agent(stubProvider(), stubDb(), undefined, {
      enablePlanning: false,
      enableReflection: false,
    });
    await agent.startConversation({ name: "test" });

    const first = await runAndCollectEvents(agent, "do something coding related");
    const second = await runAndCollectEvents(agent, "do something else");
    expect(first.some((e) => e.message === "Skill behavior controls applied")).toBe(true);
    expect(second.some((e) => e.message === "Skill behavior controls applied")).toBe(true);
    expect(second.some((e) => e.message === "Skills aus vorherigem Versuch wiederverwendet")).toBe(false);
  });
});
