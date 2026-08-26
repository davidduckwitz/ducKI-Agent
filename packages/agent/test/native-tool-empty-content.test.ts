import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent";

function stubDb() {
  let nextId = 1;
  const messages: any[] = [];
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
    getEverUsedSkills: async () => [],
    createConversation: async (data: { name: string }) => ({ id: 1, name: data.name }),
    addMessage: async (data: any) => ({ id: nextId++, ...data }),
    getMessages: async () => messages,
  };
  return new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as any;
}

describe("native tool calls with empty text content", () => {
  it("executes the first native call after a tool result instead of replacing it with recovery", async () => {
    const calls = [
      { id: "call_list", type: "function", function: { name: "filesystem", arguments: '{"action":"list","path":"src"}' } },
      { id: "call_read", type: "function", function: { name: "filesystem", arguments: '{"action":"read","path":"src/config.js"}' } },
    ];
    let generation = 0;
    const seenMessages: any[][] = [];
    const generate = vi.fn(async (messages: any[]) => {
      seenMessages.push(messages);
      const index = generation++;
      return {
        content: index < 2 ? "" : "Done.",
        model: "native-test-model",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
        toolCalls: index < 2 ? [calls[index]] : [],
      };
    });
    const provider = {
      model: "native-test-model",
      generate,
      generateStream: generate,
      supportsStreaming: () => false,
      supportsNativeTools: () => true,
    } as any;
    const executed: string[] = [];
    const events: Array<{ type: string; message: string }> = [];
    const agent = new Agent(provider, stubDb(), undefined, {
      enablePlanning: false,
      enableReflection: false,
      disableQualityPasses: true,
      maxIterations: 5,
    });
    agent.executor.registerTool({
      name: "filesystem",
      description: "test filesystem",
      definition: { name: "filesystem", description: "test", parameters: { type: "object", properties: {} } },
      execute: async (input: Record<string, unknown>) => {
        executed.push(String(input["action"]));
        return { success: true, data: { ok: true } };
      },
    } as any);

    const result = await agent.run("Inspect the project files and answer.", {
      agentMode: "full",
      onEvent: (event: any) => events.push({ type: event.type, message: event.message }),
    });

    expect(executed).toEqual(["list", "read"]);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(seenMessages[1]?.some((message) =>
      message.role === "assistant" && message.toolCalls?.[0]?.id === "batch_1_0"
    )).toBe(true);
    expect(seenMessages[1]?.some((message) =>
      message.role === "tool" && message.toolCallId === "batch_1_0"
    )).toBe(true);
    expect(events.some((event) => event.message.includes("antwortete leer"))).toBe(false);
    expect(result.response).toBe("Done.");
  });
});
