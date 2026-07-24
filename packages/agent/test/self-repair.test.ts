import { describe, expect, it } from "vitest";
import { createAgentForParserTests } from "./utils/agent-test-harness.ts";

type PrivateRepairMethods = {
  deriveMechanicalRepair: (
    toolName: string,
    toolInput: Record<string, unknown>
  ) => { toolName: string; input: Record<string, unknown> } | undefined;
  extractJsonObject: (text: string) => Record<string, unknown> | undefined;
  levenshtein: (a: string, b: string) => number;
};

function asPrivate(agent: ReturnType<typeof createAgentForParserTests>): PrivateRepairMethods {
  return agent as unknown as PrivateRepairMethods;
}

describe("agent self-repair", () => {
  it("snaps a misspelled enum value to the nearest schema-declared option", () => {
    const agent = createAgentForParserTests();
    agent.executor.registerTool({
      name: "task",
      description: "test tool",
      definition: {
        name: "task",
        description: "test tool",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "list", "get", "update", "complete", "delete"] },
          },
          required: ["action"],
        },
      },
      execute: async () => ({ success: true, data: null }),
    });

    const repaired = asPrivate(agent).deriveMechanicalRepair("task", { action: "compelte" });

    expect(repaired?.toolName).toBe("task");
    expect(repaired?.input["action"]).toBe("complete");
  });

  it("leaves input untouched when the enum value is already valid", () => {
    const agent = createAgentForParserTests();
    agent.executor.registerTool({
      name: "task",
      description: "test tool",
      definition: {
        name: "task",
        description: "test tool",
        parameters: {
          type: "object",
          properties: { action: { type: "string", enum: ["create", "list"] } },
          required: ["action"],
        },
      },
      execute: async () => ({ success: true, data: null }),
    });

    const repaired = asPrivate(agent).deriveMechanicalRepair("task", { action: "create" });

    expect(repaired).toBeUndefined();
  });

  it("returns undefined when no enum value is close enough to guess", () => {
    const agent = createAgentForParserTests();
    agent.executor.registerTool({
      name: "task",
      description: "test tool",
      definition: {
        name: "task",
        description: "test tool",
        parameters: {
          type: "object",
          properties: { action: { type: "string", enum: ["create", "list"] } },
          required: ["action"],
        },
      },
      execute: async () => ({ success: true, data: null }),
    });

    const repaired = asPrivate(agent).deriveMechanicalRepair("task", { action: "zzzzzzzz" });

    expect(repaired).toBeUndefined();
  });

  it("extracts raw JSON responses", () => {
    const agent = createAgentForParserTests();
    const parsed = asPrivate(agent).extractJsonObject('{"input":{"action":"list"}}');
    expect(parsed).toEqual({ input: { action: "list" } });
  });

  it("extracts JSON wrapped in a markdown code fence", () => {
    const agent = createAgentForParserTests();
    const parsed = asPrivate(agent).extractJsonObject('```json\n{"input":{"action":"list"}}\n```');
    expect(parsed).toEqual({ input: { action: "list" } });
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const agent = createAgentForParserTests();
    const parsed = asPrivate(agent).extractJsonObject(
      'Sure, here is the fix: {"input":{"action":"list"}} — hope that helps!'
    );
    expect(parsed).toEqual({ input: { action: "list" } });
  });

  it("returns undefined for unparseable text", () => {
    const agent = createAgentForParserTests();
    const parsed = asPrivate(agent).extractJsonObject("I cannot help with that.");
    expect(parsed).toBeUndefined();
  });
});
