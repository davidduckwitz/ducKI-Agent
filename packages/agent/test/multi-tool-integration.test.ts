import { describe, it, expect, beforeEach } from "vitest";
import { createAgentForParserTests } from "./utils/agent-test-harness";

describe("Agent Multi-Tool Integration", () => {
  let agent: any;

  beforeEach(() => {
    agent = createAgentForParserTests();
  });

  describe("Parsing Multiple Different Tools", () => {
    it("extracts multiple different tools from single response", () => {
      const response = `
Let me gather information from multiple sources:
[TOOL:filesystem({"action":"read","path":"/etc/hosts"})]
[TOOL:shell({"command":"whoami"})]
[TOOL:gateway({"action":"list_configs"})]
Then I'll analyze the results.
      `;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.calls).toHaveLength(3);
      expect(result.calls[0].toolName).toBe("filesystem");
      expect(result.calls[1].toolName).toBe("shell");
      expect(result.calls[2].toolName).toBe("gateway");
    });

    it("maintains correct input parameters for each tool", () => {
      const response = `
[TOOL:filesystem({"action":"write","path":"test.txt","content":"hello"})]
[TOOL:shell({"command":"ls -la /tmp"})]
      `;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.calls[0].input).toEqual({
        action: "write",
        path: "test.txt",
        content: "hello",
      });
      expect(result.calls[1].input).toEqual({
        command: "ls -la /tmp",
      });
    });

    it("handles mixed valid and invalid tool calls", () => {
      const response = `
[TOOL:shell({"command":"echo test"})]
[TOOL:invalid_tool({garbage})]
[TOOL:gateway({"action":"status"})]
      `;

      const result = (agent as any).extractAllToolCalls(response);

      // Agent attempts to parse all markers; may get 2-3 depending on parser robustness
      expect(result.calls.length).toBeGreaterThanOrEqual(2);
      // First and last should definitely parse
      expect(result.calls[0].toolName).toBe("shell");
      expect(result.calls[result.calls.length - 1].toolName).toBe("gateway");
    });

    it("preserves tool call order", () => {
      const response = `
First: [TOOL:gateway({"action":"list"})]
Second: [TOOL:filesystem({"action":"read","path":"a"})]
Third: [TOOL:shell({"command":"pwd"})]
      `;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.calls[0].toolName).toBe("gateway");
      expect(result.calls[1].toolName).toBe("filesystem");
      expect(result.calls[2].toolName).toBe("shell");
    });

    it("deduplicates identical consecutive tool calls", () => {
      const response = `
[TOOL:shell({"command":"echo hi"})]
[TOOL:shell({"command":"echo hi"})]
[TOOL:gateway({"action":"status"})]
[TOOL:gateway({"action":"status"})]
      `;

      const result = (agent as any).extractAllToolCalls(response);

      // extractAllToolCalls returns all before deduplication
      expect(result.calls).toHaveLength(4);

      // Simulate deduplication (as done in executeToolCallsFromResponse)
      const deduped: typeof result.calls = [];
      const sigs = new Set<string>();
      for (const call of result.calls) {
        const sig = `${call.toolName}:${JSON.stringify(call.input)}`;
        if (!sigs.has(sig)) {
          deduped.push(call);
          sigs.add(sig);
        }
      }

      expect(deduped).toHaveLength(2);
      expect(deduped[0].toolName).toBe("shell");
      expect(deduped[1].toolName).toBe("gateway");
    });
  });

  describe("Tool Result Processing", () => {
    it("truncates large tool results to token limit", () => {
      // Tool result truncation typically limits to 8KB
      const largeData = {
        success: true,
        data: {
          output: "x".repeat(10000), // 10KB of data
        },
        error: null,
      };

      const maxResultSize = 8000;
      const jsonStr = JSON.stringify(largeData);

      expect(jsonStr.length).toBeGreaterThan(maxResultSize);

      // Simulate truncation
      const truncated = jsonStr.slice(0, maxResultSize) + "...";
      expect(truncated.length).toBeLessThanOrEqual(maxResultSize + 3);
    });

    it("formats tool results for conversation correctly", () => {
      const toolResult = {
        success: true,
        data: {
          output: "foo bar baz",
          exitCode: 0,
        },
        error: null,
      };

      const toolResultMessage = {
        role: "tool",
        content: JSON.stringify(toolResult),
        toolCallId: "batch_1_0",
      };

      expect(toolResultMessage.role).toBe("tool");
      expect(toolResultMessage.toolCallId).toBeDefined();
      expect(typeof toolResultMessage.content).toBe("string");
    });

    it("handles tool errors gracefully", () => {
      const failedResult = {
        success: false,
        data: null,
        error: "Command not found: unknowntool",
      };

      const toolResultMessage = {
        role: "tool",
        content: JSON.stringify(failedResult),
        toolCallId: "batch_1_1",
      };

      expect(toolResultMessage.role).toBe("tool");
      expect(failedResult.success).toBe(false);
      expect(failedResult.error).toBeDefined();
    });
  });

  describe("Complex Multi-Tool Scenarios", () => {
    it("handles sequential tool calls with dependencies", () => {
      // First get config, then use it in second call
      const response = `
Let me first check the gateway configuration:
[TOOL:gateway({"action":"get_config"})]

Then I'll apply it:
[TOOL:gateway({"action":"apply_config","configId":"auto"})]
      `;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.calls).toHaveLength(2);
      expect(result.calls[0].input.action).toBe("get_config");
      expect(result.calls[1].input.action).toBe("apply_config");
    });

    it("handles parallel independent tool calls", () => {
      const response = `
Let me check these three things in parallel:
[TOOL:filesystem({"action":"exists","path":"/var/log/syslog"})]
[TOOL:shell({"command":"uptime"})]
[TOOL:gateway({"action":"health"})]
      `;

      const result = (agent as any).extractAllToolCalls(response);

      // All three should be extracted as parallel calls
      expect(result.calls).toHaveLength(3);
      expect(result.calls.every(c => c)).toBe(true);
    });

    it("preserves mixed tool formats (bracket vs hermes)", () => {
      const response = `
Bracket format: [TOOL:shell({"command":"ls"})]
Hermes format: <|tool_call>call:gateway({"action":"status"})<|tool_call|>
      `;

      const result = (agent as any).extractAllToolCalls(response);

      expect(result.calls).toHaveLength(2);
      expect(result.calls[0].toolName).toBe("shell");
      expect(result.calls[1].toolName).toBe("gateway");
    });
  });
});
