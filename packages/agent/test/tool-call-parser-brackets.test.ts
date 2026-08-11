import { describe, it, expect } from "vitest";
import { createAgentForParserTests } from "./utils/agent-test-harness";

describe("Tool Call Parser – Bracket Payload Handling (PR1-A1)", () => {
  describe("extractAllToolCalls with complex payloads", () => {
    it("parses two calls where one has array with ] inside", () => {
      const agent = createAgentForParserTests();
      const response = `[TOOL:filesystem({"action":"write","path":"a.json","content":"[1,2,3]"})] OK, then [TOOL:shell({"command":"echo hi"})]`;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.markerCount).toBe(2);
      expect(result.calls).toHaveLength(2);
      expect(result.calls[0].toolName).toBe("filesystem");
      expect(result.calls[0].input.content).toBe("[1,2,3]");
      expect(result.calls[1].toolName).toBe("shell");
      expect(result.unparsed).toHaveLength(0);
    });

    it("reports unparsed marker when body cannot be parsed", () => {
      const agent = createAgentForParserTests();
      // toolname starting with number is invalid; body has no valid format
      const response = `[TOOL:filesystem({"action":"write"})] and [TOOL:9invalid({incomplete`;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.markerCount).toBe(2);
      expect(result.calls).toHaveLength(1); // only the first parses
      expect(result.calls[0].toolName).toBe("filesystem");
      expect(result.unparsed).toHaveLength(1);
    });

    it("handles nested array in string correctly", () => {
      const agent = createAgentForParserTests();
      const response = `[TOOL:filesystem({"action":"write","path":"data.json","content":"{\\"items\\":[[1,2],[3,4]]}"})]`;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.markerCount).toBe(1);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].input.content).toContain("[[1,2],[3,4]]");
      expect(result.unparsed).toHaveLength(0);
    });

    it("single marker still returns via extractAllToolCalls", () => {
      const agent = createAgentForParserTests();
      const response = `[TOOL:shell({"command":"ls -la"})]`;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.markerCount).toBe(1);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].toolName).toBe("shell");
      expect(result.unparsed).toHaveLength(0);
    });
  });

  describe("space-separated key=value bracket calls (Variant E)", () => {
    it("parses the exact failing filesystem write from the report (quotes, newlines, parens, URLs)", () => {
      const agent = createAgentForParserTests();
      const response =
        '[TOOL:filesystem action=write path=./weather_news_report.md basePath=./shared-workspace ' +
        'content="# Wetter- und Nachrichtenbericht\\n\\n## Wetter in Fulda\\n- **Temperatur:** 22,6 °C\\n\\n' +
        '1. **Schlichtung bei Lufthansa** (tagesschau)\\n   <https://www.tagesschau.de/x.html>"]';

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.calls).toHaveLength(1);
      expect(result.unparsed).toHaveLength(0);
      const call = result.calls[0];
      expect(call.toolName).toBe("filesystem");
      expect(call.input.action).toBe("write");
      expect(call.input.path).toBe("./weather_news_report.md");
      expect(call.input.basePath).toBe("./shared-workspace");
      // Escaped \n became a real newline; parens and <url> survived intact.
      expect(call.input.content).toContain("# Wetter- und Nachrichtenbericht\n");
      expect(call.input.content).toContain("(tagesschau)");
      expect(call.input.content).toContain("<https://www.tagesschau.de/x.html>");
    });

    it("parses bare and single-quoted values", () => {
      const agent = createAgentForParserTests();
      const result = (agent as any).extractAllToolCalls("[TOOL:filesystem action=read path='./my file.md']");
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].input.action).toBe("read");
      expect(result.calls[0].input.path).toBe("./my file.md");
      expect(result.unparsed).toHaveLength(0);
    });

    it("still prefers JSON payloads (Variant E does not shadow them)", () => {
      const agent = createAgentForParserTests();
      const result = (agent as any).extractAllToolCalls('[TOOL:shell({"command":"echo hi=there"})]');
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].input.command).toBe("echo hi=there");
    });
  });

  describe("scanBracketPayload helper", () => {
    it("correctly finds closing bracket at any nesting depth", () => {
      const agent = createAgentForParserTests();
      const text = `filesystem({"nested":{"deep":{"data":"[1,2,3]"}}})`;

      const result = (agent as any).scanBracketPayload(text, 0);

      expect(result).toBeDefined();
      expect(result!.body).toContain("nested");
      expect(result!.endIndex).toBeGreaterThan(0);
    });

    it("returns undefined for empty start pos", () => {
      const agent = createAgentForParserTests();
      const result = (agent as any).scanBracketPayload("", 0);

      expect(result).toBeUndefined();
    });

    it("handles unclosed bracket (fallback to rest of string)", () => {
      const agent = createAgentForParserTests();
      const text = `filesystem({"action":"read"`;

      const result = (agent as any).scanBracketPayload(text, 0);

      expect(result).toBeDefined();
      expect(result!.body).toContain("action");
    });

    it("keeps full multi-line body on unterminated payload (does not cut at first newline)", () => {
      const agent = createAgentForParserTests();
      // Real newlines inside content, and truncated before the closing `})` -
      // mirrors the write_file failure where the body was cut at line one.
      const text = `write_file({"path":"a.md","content":"# Title\nsecond line\nthird line`;

      const result = (agent as any).scanBracketPayload(text, 0);

      expect(result).toBeDefined();
      expect(result!.body).toContain("second line");
      expect(result!.body).toContain("third line");
    });
  });

  describe("literal newlines inside string values", () => {
    it("parses write_file whose content has raw (unescaped) newlines", () => {
      const agent = createAgentForParserTests();
      const content = "# Konzept\n\n## 1. Einleitung\nText mit (Klammern) und Umlauten.";
      const response = `[TOOL:write_file({"path":"./shared-workspace/x.md","content":"${content}"})]`;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.markerCount).toBe(1);
      expect(result.calls).toHaveLength(1);
      // write_file resolves onto the filesystem tool with action "write"
      expect(result.calls[0].toolName).toBe("filesystem");
      expect(result.calls[0].input.action).toBe("write");
      expect(result.calls[0].input.content).toBe(content);
      expect(result.unparsed).toHaveLength(0);
    });
  });
});
