import { describe, it, expect } from "vitest";
import { createAgentForParserTests, extractHermesCall, parseLooseObject, parseToolCall } from "./utils/agent-test-harness.ts";

/**
 * Test suite for enhanced tool call parsing.
 * Exercises the real Agent parser methods (via the test harness) rather than
 * re-implemented copies, so a regression in agent.ts actually fails these tests.
 */
describe("Enhanced Tool Call Parser", () => {
  describe("Extract Hermes Call", () => {
    it("should extract standard <|tool_call>call: format", () => {
      const agent = createAgentForParserTests();
      const result = extractHermesCall(agent, `<|tool_call>call:task({"action": "create"})`);
      expect(result).toBeDefined();
      expect(result?.toolName).toBe("task");
    });

    it("should extract shorthand <|tool_call> format", () => {
      const agent = createAgentForParserTests();
      const result = extractHermesCall(agent, `<|tool_call>project({"action": "list"})`);
      expect(result).toBeDefined();
      expect(result?.toolName).toBe("project");
    });

    it("should handle malformed call with json wrapper", () => {
      const agent = createAgentForParserTests();
      const result = extractHermesCall(agent, `<|tool_call>call:task({json: {"action": "create"}})`);
      expect(result).toBeDefined();
      expect(result?.toolName).toBe("task");
    });

    it("should handle end markers properly", () => {
      const agent = createAgentForParserTests();
      const result = extractHermesCall(agent, `<|tool_call>call:shell({"command": "ls"})<|tool_call|>extra text`);
      expect(result).toBeDefined();
      expect(result?.toolName).toBe("shell");
    });

    it("should extract brace-style format", () => {
      const agent = createAgentForParserTests();
      const result = extractHermesCall(agent, `<|tool_call>task{"action": "create", "title": "Test"}`);
      expect(result).toBeDefined();
      expect(result?.toolName).toBe("task");
    });
  });

  describe("Standard Bracket Format", () => {
    it("should parse [TOOL:name({...})] end to end", () => {
      const agent = createAgentForParserTests();
      const parsed = parseToolCall(agent, '[TOOL:task({"action": "create", "title": "My Task"})]');

      expect(parsed?.toolName).toBe("task");
      expect(parsed?.input).toMatchObject({ action: "create", title: "My Task" });
    });

    it("should handle compact object format without parentheses", () => {
      const agent = createAgentForParserTests();
      const parsed = parseToolCall(agent, '[TOOL:project{"action": "list"}]');

      expect(parsed?.toolName).toBe("project");
      expect(parsed?.input).toEqual({ action: "list" });
    });
  });

  describe("JSON Parsing Edge Cases", () => {
    it("parses already-valid quoted-key JSON", () => {
      const agent = createAgentForParserTests();
      const parsed = parseLooseObject(agent, '{"action": "create"}');
      expect(parsed?.["action"]).toBe("create");
    });

    it("normalizes unquoted keys before parsing", () => {
      const agent = createAgentForParserTests();
      const parsed = parseLooseObject(agent, '{action: "create"}');
      expect(parsed?.["action"]).toBe("create");
    });

    it("keeps numeric values as numbers", () => {
      const agent = createAgentForParserTests();
      const parsed = parseLooseObject(agent, '{"id": 123, "count": 45}');
      expect(parsed?.["id"]).toBe(123);
      expect(typeof parsed?.["id"]).toBe("number");
    });

    it("keeps quoted numbers as strings", () => {
      const agent = createAgentForParserTests();
      const parsed = parseLooseObject(agent, '{"id": "123"}');
      expect(typeof parsed?.["id"]).toBe("string");
    });
  });

  describe("Tool Call Format Tolerance", () => {
    it("unwraps a {json: {...}} wrapper without corrupting the payload", () => {
      const agent = createAgentForParserTests();
      const parsed = parseLooseObject(agent, '{json: {"action": "create"}}');
      // Regression guard: an unanchored unwrap regex here previously left a
      // dangling duplicate closing brace (`{{"action":"create"}}`), which is
      // invalid JSON and only "worked" by accident via a fallback parser.
      expect(parsed).toEqual({ action: "create" });
    });

    it("unwraps an {args: {...}} wrapper without corrupting the payload", () => {
      const agent = createAgentForParserTests();
      const parsed = parseLooseObject(agent, '{args: {"action": "list"}}');
      expect(parsed).toEqual({ action: "list" });
    });

    it("handles mixed single/double quote styles", () => {
      const agent = createAgentForParserTests();
      const parsed = parseLooseObject(agent, `{action: "create", description: 'My Task'}`);
      expect(parsed?.["action"]).toBe("create");
      expect(parsed?.["description"]).toBe("My Task");
    });

    it("tolerates a trailing comma", () => {
      const agent = createAgentForParserTests();
      const parsed = parseLooseObject(agent, '{"action": "create", "title": "Test",}');
      expect(parsed?.["action"]).toBe("create");
      expect(parsed?.["title"]).toBe("Test");
    });
  });

  describe("Real-World Examples", () => {
    it("parses the originally reported failure case end to end", () => {
      const agent = createAgentForParserTests();
      const response = `<|tool_call>call:task({"action": "create", "title": "Discussion Board Implementation", "projectId": 1})`;
      const hermesCall = extractHermesCall(agent, response);
      expect(hermesCall?.toolName).toBe("task");

      const args = parseLooseObject(agent, hermesCall!.args);
      expect(args).toEqual({ action: "create", title: "Discussion Board Implementation", projectId: 1 });
    });

    it("handles complex nested JSON", () => {
      const agent = createAgentForParserTests();
      const parsed = parseLooseObject(
        agent,
        '{"action": "post", "url": "https://api.test.com", "body": {"name": "John", "email": "john@test.com"}}'
      );
      expect((parsed?.["body"] as Record<string, unknown> | undefined)?.["name"]).toBe("John");
    });

    it("handles array values", () => {
      const agent = createAgentForParserTests();
      const parsed = parseLooseObject(
        agent,
        '{"action": "batch", "operations": [{"action": "add"}, {"action": "remove"}]}'
      );
      expect(Array.isArray(parsed?.["operations"])).toBe(true);
      expect((parsed?.["operations"] as unknown[]).length).toBe(2);
    });

    it("handles escaped quotes in strings", () => {
      const agent = createAgentForParserTests();
      const parsed = parseLooseObject(agent, '{"title": "He said \\"Hello\\" to me"}');
      expect(parsed?.["title"]).toContain("Hello");
    });
  });

  describe("Error Detection & Recovery", () => {
    it("returns undefined when no key can be recovered at all", () => {
      const agent = createAgentForParserTests();
      const parsed = parseLooseObject(agent, ": create");
      expect(parsed).toBeUndefined();
    });

    it("returns an empty object for a call with no arguments", () => {
      const agent = createAgentForParserTests();
      const parsed = parseLooseObject(agent, "");
      expect(parsed).toEqual({});
    });

    it("returns undefined from extractToolCall when no tool call marker is present", () => {
      const agent = createAgentForParserTests();
      const parsed = parseToolCall(agent, "just some regular text with no tool call in it");
      expect(parsed).toBeUndefined();
    });

    it("recovers bare/unquoted values leniently instead of throwing", () => {
      // Small local models frequently omit quotes entirely; the manual fallback
      // parser recovers key/value pairs rather than rejecting the call outright.
      const agent = createAgentForParserTests();
      const parsed = parseLooseObject(agent, "{action: create, title: my task}");
      expect(parsed?.["action"]).toBe("create");
      expect(parsed?.["title"]).toBe("my task");
    });
  });
});
