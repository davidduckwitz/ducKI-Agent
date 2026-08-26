import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition, ToolExecutor, ToolResult } from "@ducki/shared";
import {
  estimateTotalToolTokens,
  shouldActivateProgressiveDisclosure,
  partitionTools,
  createBridgeToolExecutors,
  createToolSearchDefinition,
  createToolDescribeDefinition,
  createToolCallDefinition,
} from "../src/tools/tool-search-bridge.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeToolDef(name: string, description?: string, paramCount = 3): ToolDefinition {
  const properties: Record<string, { type: string; description: string }> = {};
  for (let i = 0; i < paramCount; i++) {
    properties[`param_${i}`] = { type: "string", description: `Parameter ${i} for ${name}` };
  }
  return {
    name,
    description: description ?? `${name} tool for doing ${name} things`,
    parameters: { type: "object", properties, required: ["param_0"] },
  };
}

function makeToolExecutor(def: ToolDefinition): ToolExecutor {
  return {
    name: def.name,
    description: def.description,
    definition: def,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      return { success: true, data: { executed: true, input }, disposition: "success" };
    },
  };
}

function makeFakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

// ── estimateTotalToolTokens ──────────────────────────────────────────────────

describe("estimateTotalToolTokens", () => {
  it("returns > 0 for any tool definitions", () => {
    const defs = [makeToolDef("t1"), makeToolDef("t2")];
    expect(estimateTotalToolTokens(defs)).toBeGreaterThan(0);
  });

  it("scales with number of tools", () => {
    const small = estimateTotalToolTokens([makeToolDef("t1")]);
    const large = estimateTotalToolTokens([makeToolDef("t1"), makeToolDef("t2"), makeToolDef("t3")]);
    expect(large).toBeGreaterThan(small);
  });

  it("scales with description length", () => {
    const short = estimateTotalToolTokens([makeToolDef("t1", "short")]);
    const long = estimateTotalToolTokens([makeToolDef("t1", "a".repeat(500))]);
    expect(long).toBeGreaterThan(short);
  });
});

// ── shouldActivateProgressiveDisclosure ──────────────────────────────────────

describe("shouldActivateProgressiveDisclosure", () => {
  it("does not activate when tools are few", () => {
    const defs = [makeToolDef("t1"), makeToolDef("t2")];
    const result = shouldActivateProgressiveDisclosure(defs, 100000);
    expect(result.active).toBe(false);
  });

  it("activates when tools exceed threshold", () => {
    // Create many large tool definitions
    const defs = Array.from({ length: 50 }, (_, i) =>
      makeToolDef(`tool_${i}`, `A very long description ${"x".repeat(200)} for tool ${i}`, 8)
    );
    const result = shouldActivateProgressiveDisclosure(defs, 1000);
    expect(result.active).toBe(true);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it("respects custom threshold", () => {
    const defs = [makeToolDef("t1"), makeToolDef("t2")];
    // With very low threshold, even few tools activate
    const result = shouldActivateProgressiveDisclosure(defs, 100000, 0.0001);
    expect(result.active).toBe(true);
  });

  it("returns correct threshold percent", () => {
    const defs: ToolDefinition[] = [];
    const result = shouldActivateProgressiveDisclosure(defs, 100000, 0.75);
    expect(result.thresholdPercent).toBe(75);
  });
});

// ── partitionTools ───────────────────────────────────────────────────────────

describe("partitionTools", () => {
  it("partitions core and deferred tools correctly", () => {
    const defs = [
      makeToolDef("filesystem", "File operations"),
      makeToolDef("shell", "Shell commands"),
      makeToolDef("browser", "Browser automation"),
      makeToolDef("custom_script_tool", "A custom script tool"),
      makeToolDef("optional_analyzer", "Optional analysis tool"),
    ];
    const { core, deferred } = partitionTools(defs);
    expect(core.map((d) => d.name)).toContain("filesystem");
    expect(core.map((d) => d.name)).toContain("shell");
    expect(core.map((d) => d.name)).toContain("browser");
    expect(deferred.map((d) => d.name)).toContain("custom_script_tool");
    expect(deferred.map((d) => d.name)).toContain("optional_analyzer");
    expect(deferred.map((d) => d.name)).not.toContain("filesystem");
  });

  it("bridge tools are always core", () => {
    const defs = [
      makeToolDef("tool_search"),
      makeToolDef("tool_describe"),
      makeToolDef("tool_call"),
    ];
    const { core, deferred } = partitionTools(defs);
    expect(core).toHaveLength(3);
    expect(deferred).toHaveLength(0);
  });

  it("all tools can be core if no deferred ones", () => {
    const defs = [makeToolDef("filesystem"), makeToolDef("shell"), makeToolDef("memory")];
    const { core, deferred } = partitionTools(defs);
    expect(core).toHaveLength(3);
    expect(deferred).toHaveLength(0);
  });
});

// ── Bridge tool definitions ──────────────────────────────────────────────────

describe("bridge tool definitions", () => {
  it("tool_search has correct shape", () => {
    const def = createToolSearchDefinition();
    expect(def.name).toBe("tool_search");
    expect(def.parameters.type).toBe("object");
    expect(def.parameters.properties.query).toBeDefined();
    expect(def.parameters.required).toContain("query");
  });

  it("tool_describe has correct shape", () => {
    const def = createToolDescribeDefinition();
    expect(def.name).toBe("tool_describe");
    expect(def.parameters.properties.tool_name).toBeDefined();
    expect(def.parameters.required).toContain("tool_name");
  });

  it("tool_call has correct shape", () => {
    const def = createToolCallDefinition();
    expect(def.name).toBe("tool_call");
    expect(def.parameters.properties.tool_name).toBeDefined();
    expect(def.parameters.properties.arguments).toBeDefined();
    expect(def.parameters.required).toContain("tool_name");
    expect(def.parameters.required).toContain("arguments");
  });
});

// ── createBridgeToolExecutors ────────────────────────────────────────────────

describe("createBridgeToolExecutors", () => {
  const deferred1 = makeToolDef("custom_tool", "A custom tool for specific tasks");
  const deferred2 = makeToolDef("analyzer", "Analyze code patterns");
  const core = makeToolDef("filesystem", "File operations");
  const allDefs = [core, deferred1, deferred2];
  const toolMap = new Map<string, ToolExecutor>([
    ["custom_tool", makeToolExecutor(deferred1)],
    ["analyzer", makeToolExecutor(deferred2)],
    ["filesystem", makeToolExecutor(core)],
  ]);

  function getTool(name: string) { return toolMap.get(name); }

  it("returns three bridge tools", () => {
    const logger = makeFakeLogger();
    const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
    expect(bridges).toHaveLength(3);
    expect(bridges.map((b) => b.name)).toEqual(["tool_search", "tool_describe", "tool_call"]);
  });

  describe("tool_search", () => {
    it("finds tools by keyword in name", async () => {
      const logger = makeFakeLogger();
      const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
      const search = bridges.find((b) => b.name === "tool_search")!;

      const result = await search.execute({ query: "custom" });
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.matchCount).toBe(1);
      expect(data.tools[0].name).toBe("custom_tool");
    });

    it("finds tools by keyword in description", async () => {
      const logger = makeFakeLogger();
      const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
      const search = bridges.find((b) => b.name === "tool_search")!;

      const result = await search.execute({ query: "analyze code" });
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.matchCount).toBe(1);
      expect(data.tools[0].name).toBe("analyzer");
    });

    it("returns empty for no match", async () => {
      const logger = makeFakeLogger();
      const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
      const search = bridges.find((b) => b.name === "tool_search")!;

      const result = await search.execute({ query: "nonexistent_xyz" });
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.matchCount).toBe(0);
      expect(data.hint).toContain("No tools matched");
    });

    it("rejects empty query", async () => {
      const logger = makeFakeLogger();
      const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
      const search = bridges.find((b) => b.name === "tool_search")!;

      const result = await search.execute({ query: "" });
      expect(result.success).toBe(false);
    });

    it("does not include core tools in search results", async () => {
      const logger = makeFakeLogger();
      const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
      const search = bridges.find((b) => b.name === "tool_search")!;

      const result = await search.execute({ query: "file" });
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.tools.find((t: any) => t.name === "filesystem")).toBeUndefined();
    });
  });

  describe("tool_describe", () => {
    it("returns full schema for a known tool", async () => {
      const logger = makeFakeLogger();
      const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
      const describe = bridges.find((b) => b.name === "tool_describe")!;

      const result = await describe.execute({ tool_name: "custom_tool" });
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.name).toBe("custom_tool");
      expect(data.description).toContain("custom tool");
      expect(data.parameters).toBeDefined();
      expect(data.usage).toContain("tool_call");
    });

    it("fails for unknown tool with suggestions", async () => {
      const logger = makeFakeLogger();
      const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
      const describe = bridges.find((b) => b.name === "tool_describe")!;

      const result = await describe.execute({ tool_name: "cust" });
      expect(result.success).toBe(false);
    });

    it("fails for completely unknown tool", async () => {
      const logger = makeFakeLogger();
      const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
      const describe = bridges.find((b) => b.name === "tool_describe")!;

      const result = await describe.execute({ tool_name: "zzz_nonexistent" });
      expect(result.success).toBe(false);
      expect((result as any).error).toContain("not found");
    });

    it("rejects empty tool_name", async () => {
      const logger = makeFakeLogger();
      const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
      const describe = bridges.find((b) => b.name === "tool_describe")!;

      const result = await describe.execute({ tool_name: "" });
      expect(result.success).toBe(false);
    });
  });

  describe("tool_call", () => {
    it("executes a deferred tool with arguments", async () => {
      const logger = makeFakeLogger();
      const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
      const call = bridges.find((b) => b.name === "tool_call")!;

      const result = await call.execute({
        tool_name: "custom_tool",
        arguments: { param_0: "hello" },
      });
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.executed).toBe(true);
    });

    it("fails for core tools (they should be called directly)", async () => {
      const logger = makeFakeLogger();
      const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
      const call = bridges.find((b) => b.name === "tool_call")!;

      const result = await call.execute({
        tool_name: "filesystem",
        arguments: { action: "read", path: "/tmp/test" },
      });
      expect(result.success).toBe(false);
      expect((result as any).error).toContain("core tool");
    });

    it("fails for unknown tool", async () => {
      const logger = makeFakeLogger();
      const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
      const call = bridges.find((b) => b.name === "tool_call")!;

      const result = await call.execute({
        tool_name: "nonexistent",
        arguments: {},
      });
      expect(result.success).toBe(false);
      expect((result as any).error).toContain("not found");
    });

    it("rejects missing arguments", async () => {
      const logger = makeFakeLogger();
      const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
      const call = bridges.find((b) => b.name === "tool_call")!;

      const result = await call.execute({ tool_name: "custom_tool" });
      expect(result.success).toBe(false);
    });

    it("rejects array arguments", async () => {
      const logger = makeFakeLogger();
      const bridges = createBridgeToolExecutors(allDefs, getTool, logger);
      const call = bridges.find((b) => b.name === "tool_call")!;

      const result = await call.execute({
        tool_name: "custom_tool",
        arguments: ["not", "an", "object"],
      });
      expect(result.success).toBe(false);
    });
  });
});
