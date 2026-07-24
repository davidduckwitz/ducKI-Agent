import { describe, expect, it } from "vitest";
import { WorkflowEngine, type WorkflowGraph, type WorkflowNode } from "../src/workflow/workflow-engine.ts";
import { Executor } from "../src/executor/executor.ts";
import type { Logger } from "@ducki/logger";

type PrivateWorkflowEngineMethods = {
  executeToolCallNode: (
    workflow: WorkflowGraph,
    node: WorkflowNode
  ) => Promise<{ resultText: string; resultData?: unknown; success: boolean }>;
};

function asPrivate(engine: WorkflowEngine): PrivateWorkflowEngineMethods {
  return engine as unknown as PrivateWorkflowEngineMethods;
}

function stubLogger(): Logger {
  const noop = () => undefined;
  return { info: noop, warn: noop, error: noop, debug: noop, child: () => stubLogger() } as unknown as Logger;
}

function buildEngine(enabledOptionalToolsSetting: string | null): WorkflowEngine {
  const provider = { generate: async () => ({ content: "" }) } as unknown as ConstructorParameters<typeof WorkflowEngine>[0];
  const db = {
    getSetting: async (key: string) => (key === "ENABLED_OPTIONAL_TOOLS" ? enabledOptionalToolsSetting : null),
  } as unknown as ConstructorParameters<typeof WorkflowEngine>[1];

  const executor = new Executor(stubLogger());
  executor.registerTool({
    name: "shell",
    description: "test tool",
    definition: { name: "shell", description: "test tool", parameters: { type: "object", properties: {} } },
    execute: async () => ({ success: true, data: { ran: true } }),
  });
  executor.registerTool({
    name: "filesystem",
    description: "test tool",
    definition: { name: "filesystem", description: "test tool", parameters: { type: "object", properties: {} } },
    execute: async () => ({ success: true, data: { ran: true } }),
  });

  return new WorkflowEngine(provider, db, executor, { logger: stubLogger() });
}

function buildNode(toolName: string): WorkflowNode {
  return {
    id: "n1",
    title: "test node",
    kind: "tool_call",
    role: "manager",
    prompt: "",
    toolName,
    toolInput: {},
    status: "pending",
  };
}

const emptyWorkflow: WorkflowGraph = {
  id: "w1",
  name: "test workflow",
  goal: "",
  status: "running",
  nodes: [],
  edges: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("WorkflowEngine tool_call node gating", () => {
  it("rejects a disabled optional tool before dispatching to the executor", async () => {
    const engine = buildEngine(null);
    const result = await asPrivate(engine).executeToolCallNode(emptyWorkflow, buildNode("shell"));

    expect(result.success).toBe(false);
    expect(result.resultText).toMatch(/disabled/i);
  });

  it("allows an optional tool once it is present in ENABLED_OPTIONAL_TOOLS", async () => {
    const engine = buildEngine(JSON.stringify(["shell"]));
    const result = await asPrivate(engine).executeToolCallNode(emptyWorkflow, buildNode("shell"));

    expect(result.success).toBe(true);
  });

  it("always allows a core tool regardless of ENABLED_OPTIONAL_TOOLS", async () => {
    const engine = buildEngine(null);
    const result = await asPrivate(engine).executeToolCallNode(emptyWorkflow, buildNode("filesystem"));

    expect(result.success).toBe(true);
  });
});
