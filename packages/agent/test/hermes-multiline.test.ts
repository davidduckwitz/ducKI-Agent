import { describe, it, expect } from "vitest";
import { createAgentForParserTests } from "./utils/agent-test-harness";

describe("Hermes Call Parsing – Multiline Handling (PR1-A2)", () => {
  describe("extractHermesCall with multiline JSON payload", () => {
    it("parses multiline JSON payload without cutting at first newline", () => {
      const agent = createAgentForParserTests();
      const response = `<|tool_call>call:filesystem({\n  "action": "write",\n  "path": "test.json",\n  "content": "data"\n})<|tool_call|>`;

      const result = (agent as any).extractHermesCall(response);

      expect(result).toBeDefined();
      expect(result!.toolName).toBe("filesystem");
      expect(result!.args).toContain("action");
      expect(result!.args).toContain("content");
    });

    it("stops at newline only when brackets are balanced", () => {
      const agent = createAgentForParserTests();
      // First \n has unbalanced braces (opened { but no close yet)
      const response = `<|tool_call>shell({\n  "command": "echo",\n  "cwd": "/tmp"\n})`;

      const result = (agent as any).extractHermesCall(response);

      expect(result).toBeDefined();
      expect(result!.toolName).toBe("shell");
      expect(result!.args).toContain("command");
      expect(result!.args).toContain("cwd");
    });

    it("respects explicit close marker even with newlines", () => {
      const agent = createAgentForParserTests();
      const response = `<|tool_call>filesystem({\n  "action": "read"\n})<|tool_call|>and more text`;

      const result = (agent as any).extractHermesCall(response);

      expect(result).toBeDefined();
      expect(result!.args).toContain("action");
      // Should not include "and more text"
      expect(result!.args).not.toContain("and");
    });

    it("handles string with newline inside JSON", () => {
      const agent = createAgentForParserTests();
      const response = `<|tool_call>filesystem({\n  "action": "write",\n  "content": "line1\\nline2"\n})`;

      const result = (agent as any).extractHermesCall(response);

      expect(result).toBeDefined();
      expect(result!.args).toContain("line1");
    });

    it("falls back to rest of string when brackets never close", () => {
      const agent = createAgentForParserTests();
      const response = `<|tool_call>filesystem({"action": "read" never closes`;

      const result = (agent as any).extractHermesCall(response);

      expect(result).toBeDefined();
      expect(result!.args).toContain("action");
    });
  });

  describe("isBracketBalanced helper", () => {
    it("returns true for balanced braces", () => {
      const agent = createAgentForParserTests();
      expect((agent as any).isBracketBalanced('{"a":1}')).toBe(true);
      expect((agent as any).isBracketBalanced('{{"nested":true}}')).toBe(true);
    });

    it("returns false for unbalanced braces", () => {
      const agent = createAgentForParserTests();
      expect((agent as any).isBracketBalanced('{"a":1')).toBe(false);
      expect((agent as any).isBracketBalanced('{"a":1}}')).toBe(false);
    });

    it("ignores brackets inside strings", () => {
      const agent = createAgentForParserTests();
      expect((agent as any).isBracketBalanced('{"content":"{not counted}"}')).toBe(true);
      expect((agent as any).isBracketBalanced('{"start": "{"')).toBe(false); // opening { in string without close
    });

    it("handles escaped quotes", () => {
      const agent = createAgentForParserTests();
      expect((agent as any).isBracketBalanced('{"content":"\\\"not a close\""}')).toBe(true);
    });
  });
});
