import { describe, it, expect } from "vitest";
import { Agent, isTruncatedJsonTail } from "../src/agent";
import { createAgentForParserTests, nativeToolCallsToExtractResult } from "./utils/agent-test-harness";

/**
 * The write guard must not depend on the provider's finish_reason alone: a local backend
 * that cuts a native tool call's arguments mid-JSON and still reports "stop" would
 * otherwise write a truncated file with success:true (the JSON repair pass closes the
 * dangling string). The structural detector (isTruncatedJsonTail) and the marker it sets
 * on the parsed input are what close that gap.
 */

describe("isTruncatedJsonTail", () => {
  it("is false for complete JSON", () => {
    expect(isTruncatedJsonTail('{"action":"write","path":"a.txt","content":"hello"}')).toBe(false);
    expect(isTruncatedJsonTail('{"a":[1,2,{"b":"c"}]}')).toBe(false);
    expect(isTruncatedJsonTail("{}")).toBe(false);
    expect(isTruncatedJsonTail("")).toBe(false);
    expect(isTruncatedJsonTail("   ")).toBe(false);
  });

  it("is true when a string value is left open (the truncation fingerprint)", () => {
    expect(isTruncatedJsonTail('{"action":"write","path":"a.txt","content":"hello')).toBe(true);
    expect(isTruncatedJsonTail('{"content":"part of a long file')).toBe(true);
    // No closing brace either.
    expect(isTruncatedJsonTail('{"action":"write","path":"a.txt"')).toBe(true);
  });

  it("is true when brackets are left open", () => {
    expect(isTruncatedJsonTail('{"a":[1,2')).toBe(true);
    expect(isTruncatedJsonTail('{"a":{"b":1')).toBe(true);
  });

  it("is false for complete-but-loose JSON that repair must fix (not truncation)", () => {
    // Single quotes, unquoted keys, trailing commas, missing outer braces: all complete.
    expect(isTruncatedJsonTail("{action: 'write', path: 'a.txt', content: 'x'}")).toBe(false);
    expect(isTruncatedJsonTail('{"a":1,"b":2,}')).toBe(false);
    expect(isTruncatedJsonTail('"content":"value"')).toBe(false);
    expect(isTruncatedJsonTail("action=write path=a.txt")).toBe(false);
  });

  it("handles escaped quotes and braces inside strings", () => {
    expect(isTruncatedJsonTail('{"content":"she said \\"hi\\" and { }"}')).toBe(false);
    expect(isTruncatedJsonTail('{"content":"ends with escaped quote\\""}')).toBe(false);
    expect(isTruncatedJsonTail('{"content":"open { bracket inside string"}')).toBe(false);
  });
});

describe("native tool calls with truncated arguments", () => {
  it("marks the parsed input as truncated when the arguments JSON is cut off", () => {
    const agent = createAgentForParserTests();
    const { calls } = nativeToolCallsToExtractResult(agent, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "filesystem",
          arguments: '{"action":"write","path":"index.html","content":"<!doctype html>',
        },
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe("filesystem");
    expect(calls[0]!.input["__argsTruncated"]).toBe(true);
    // The truncated tail is still what jsonrepair handed over - the marker is what stops it.
    expect(String(calls[0]!.input["content"])).toContain("<!doctype html>");
  });

  it("does not mark complete or sloppy-but-complete arguments", () => {
    const agent = createAgentForParserTests();
    const { calls } = nativeToolCallsToExtractResult(agent, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "filesystem",
          arguments: '{"action":"write","path":"a.txt","content":"full content here"}',
        },
      },
      {
        id: "call_2",
        type: "function",
        function: {
          name: "filesystem",
          arguments: "{action: 'write', path: 'b.txt', content: 'complete'}",
        },
      },
    ]);

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.input["__argsTruncated"] === undefined)).toBe(true);
  });

  it("refuses the write in the run loop even when finish_reason says stop", async () => {
    const writeAttempts: Array<Record<string, unknown>> = [];
    const truncatedArgs =
      '{"action":"write","path":"index.html","content":"<!doctype html>\\n<html>\\n<body>';

    // The provider reports finish_reason "stop" despite handing over a cut-off call - the
    // exact local-backend behavior the structural check exists for.
    let index = 0;
    const provider = {
      model: "test-model",
      generate: async () => {
        const content = index++ === 0 ? "Ich schreibe die Datei jetzt." : "Fertig.";
        return {
          content,
          model: "test-model",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop",
          toolCalls:
            index === 1
              ? [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "filesystem", arguments: truncatedArgs },
                  },
                ]
              : [],
        };
      },
      generateStream: async () => {
        const content = index++ === 0 ? "Ich schreibe die Datei jetzt." : "Fertig.";
        return {
          content,
          model: "test-model",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop",
          toolCalls:
            index === 1
              ? [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "filesystem", arguments: truncatedArgs },
                  },
                ]
              : [],
        };
      },
      supportsStreaming: () => false,
    };

    // Proxy stub: every unknown DB method (addMemory, listConversations, ...) becomes a
    // harmless async no-op, so the run loop's bookkeeping never throws.
    const db = new Proxy(
      {
        getAllSettings: async () => [],
        getDynamicToolByName: async () => undefined,
        getSetting: async () => undefined,
        getEverUsedSkills: async () => [],
        createConversation: async (data: { name: string }) => ({ id: 1, name: data.name }),
      },
      {
        get(target, prop: string) {
          if (prop in target) return target[prop];
          return async () => undefined;
        },
      }
    );
    const agent = new Agent(provider as never, db as never, undefined, {
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
        const action = String(input["action"] ?? "");
        if (action === "write" || action === "append") {
          writeAttempts.push({ action, path: input["path"] });
          return { success: true, data: { path: input["path"], bytes: 0 } };
        }
        return { success: true, data: "ok" };
      },
    } as never);

    const result = await agent.run(
      "Bitte arbeite diesen Auftrag vollstaendig ab und stoppe erst, wenn alles erledigt ist. " +
        "Es geht um eine mehrschrittige Aufgabe, die Erkundung, Aenderungen und Verifikation umfasst.",
      { agentMode: "full" }
    );

    // The truncated write must NEVER have reached the tool - no file was written.
    expect(writeAttempts).toEqual([]);
    // And the model was told why (the refusal is a tool result the loop feeds back).
    expect(result.response.length).toBeGreaterThan(0);
  });
});
