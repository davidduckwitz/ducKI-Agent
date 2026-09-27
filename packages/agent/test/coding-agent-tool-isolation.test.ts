import { describe, expect, it } from "vitest";
import { CodingAgent } from "../src/coding/coding-agent";

function buildCodingAgent(): CodingAgent {
  const provider = {
    generate: async () => ({ content: "" }),
    generateStream: async () => ({ content: "" }),
    supportsStreaming: () => false,
    supportsNativeTools: () => true,
  } as any;
  const db = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
  } as any;
  return new CodingAgent(provider, db, undefined, {});
}

describe("CodingAgent tool isolation", () => {
  it("does not expose generic state tools that can be confused with plan progress", () => {
    const codingAgent = buildCodingAgent();
    const toolNames = (codingAgent as any).agent.executor.listTools().map((tool: { name: string }) => tool.name);

    expect(toolNames).toContain("todo");
    expect(toolNames).toContain("filesystem");
    expect(toolNames).toContain("browser");
    expect(toolNames).not.toContain("memory");
    expect(toolNames).not.toContain("plan");
    expect(toolNames).not.toContain("project");
    expect(toolNames).not.toContain("task");
    expect(toolNames).not.toContain("history");
    expect(toolNames).not.toContain("gateway");
  });
});
