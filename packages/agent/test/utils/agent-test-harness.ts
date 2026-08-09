import { Agent } from "../../src/agent.ts";

export type ParsedToolCall = { toolName: string; input: Record<string, unknown> } | undefined;

export type ExtractResult = {
  calls: Array<{ toolName: string; input: Record<string, unknown> }>;
  markerCount: number;
  unparsed: string[];
};

type NativeToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type PrivateAgentMethods = {
  extractToolCall: (response: string) => ParsedToolCall;
  extractHermesCall: (response: string) => { toolName: string; args: string } | undefined;
  parseLooseObject: (text: string) => Record<string, unknown> | undefined;
  extractAllToolCalls: (response: string) => ExtractResult;
  nativeToolCallsToExtractResult: (calls: NativeToolCall[]) => ExtractResult;
};

/** Builds a real Agent with stub provider/db so private parser methods can be exercised directly. */
export function createAgentForParserTests(): Agent {
  const provider = {
    generate: async () => ({ content: "" }),
    generateStream: async () => ({ content: "" }),
    supportsStreaming: () => false,
  } as unknown as ConstructorParameters<typeof Agent>[0];

  const db = {
    getAllSettings: async () => [],
  } as unknown as ConstructorParameters<typeof Agent>[1];

  return new Agent(provider, db, undefined, { enablePlanning: false, enableReflection: false });
}

function asPrivate(agent: Agent): PrivateAgentMethods {
  return agent as unknown as PrivateAgentMethods;
}

export function parseToolCall(agent: Agent, text: string): ParsedToolCall {
  return asPrivate(agent).extractToolCall(text);
}

export function extractHermesCall(agent: Agent, text: string): { toolName: string; args: string } | undefined {
  return asPrivate(agent).extractHermesCall(text);
}

export function parseLooseObject(agent: Agent, text: string): Record<string, unknown> | undefined {
  return asPrivate(agent).parseLooseObject(text);
}

export function extractAllToolCalls(agent: Agent, text: string): ExtractResult {
  return asPrivate(agent).extractAllToolCalls(text);
}

export function nativeToolCallsToExtractResult(agent: Agent, calls: NativeToolCall[]): ExtractResult {
  return asPrivate(agent).nativeToolCallsToExtractResult(calls);
}
