import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";

type ParsedToolCall = { toolName: string; input: Record<string, unknown> } | undefined;

function createAgentForParserTests(): Agent {
  const provider = {
    generate: async () => ({ content: "" }),
    generateStream: async () => ({ content: "" }),
    supportsStreaming: () => false,
  } as unknown as ConstructorParameters<typeof Agent>[0];

  const db = {
    getAllSettings: async () => [],
  } as unknown as ConstructorParameters<typeof Agent>[1];

  return new Agent(provider, db, { enablePlanning: false, enableReflection: false });
}

function parseToolCall(agent: Agent, text: string): ParsedToolCall {
  return (agent as unknown as { extractToolCall: (response: string) => ParsedToolCall }).extractToolCall(text);
}

describe("agent tool-call parser", () => {
  it("parses bracket format with parentheses", () => {
    const agent = createAgentForParserTests();
    const parsed = parseToolCall(agent, '[TOOL:gateway({"action":"list_configs"})]');

    expect(parsed?.toolName).toBe("gateway");
    expect(parsed?.input).toEqual({ action: "list_configs" });
  });

  it("parses bracket format with equals object", () => {
    const agent = createAgentForParserTests();
    const parsed = parseToolCall(agent, '[TOOL:gateway={"action":"list_configs"}]');

    expect(parsed?.toolName).toBe("gateway");
    expect(parsed?.input).toEqual({ action: "list_configs" });
  });

  it("parses compact bracket object format", () => {
    const agent = createAgentForParserTests();
    const parsed = parseToolCall(agent, '[TOOL:gateway{"action":"list_configs"}]');

    expect(parsed?.toolName).toBe("gateway");
    expect(parsed?.input).toEqual({ action: "list_configs" });
  });

  it("parses Hermes call format with parentheses", () => {
    const agent = createAgentForParserTests();
    const parsed = parseToolCall(agent, '<|tool_call>call:gateway({"action":"list_configs"})<|tool_call|>');

    expect(parsed?.toolName).toBe("gateway");
    expect(parsed?.input).toEqual({ action: "list_configs" });
  });

  it("parses unterminated bracket format when payload itself is complete", () => {
    const agent = createAgentForParserTests();
    const parsed = parseToolCall(agent, '[TOOL:gateway({"action":"list_configs"})');

    expect(parsed?.toolName).toBe("gateway");
    expect(parsed?.input).toEqual({ action: "list_configs" });
  });

  it("returns undefined for malformed calls", () => {
    const agent = createAgentForParserTests();
    const parsed = parseToolCall(agent, "[TOOL:gateway=]");

    expect(parsed).toBeUndefined();
  });
});
