import { describe, expect, it } from "vitest";
import { createAgentForParserTests, parseToolCall } from "./utils/agent-test-harness.ts";

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

  it("aliases title to name for project:create", () => {
    const agent = createAgentForParserTests();
    const parsed = parseToolCall(agent, '[TOOL:project({"action":"create","title":"My Project"})]');

    expect(parsed?.toolName).toBe("project");
    expect(parsed?.input["name"]).toBe("My Project");
  });

  it("aliases projectName to name for project:create", () => {
    const agent = createAgentForParserTests();
    const parsed = parseToolCall(agent, '[TOOL:project({"action":"create","projectName":"My Project"})]');

    expect(parsed?.input["name"]).toBe("My Project");
  });

  it("aliases project_name to name for project:create", () => {
    const agent = createAgentForParserTests();
    const parsed = parseToolCall(agent, '[TOOL:project({"action":"create","project_name":"My Project"})]');

    expect(parsed?.input["name"]).toBe("My Project");
  });
});
