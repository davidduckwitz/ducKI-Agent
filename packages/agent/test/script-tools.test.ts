import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScriptTools, runScriptResultSubagent } from "../src/tools/script-tools.ts";
import type { LLMProvider } from "@ducki/providers";
import type { LLMResponse } from "@ducki/shared";
import type { Logger } from "@ducki/logger";

function stubLogger(): Logger & { warnCalls: Array<{ message: string; meta?: unknown }> } {
  const warnCalls: Array<{ message: string; meta?: unknown }> = [];
  const noop = () => undefined;
  const logger = {
    info: noop,
    debug: noop,
    error: noop,
    warn: (message: string, meta?: unknown) => {
      warnCalls.push({ message, meta });
    },
    child: () => stubLogger(),
    warnCalls,
  } as unknown as Logger & { warnCalls: Array<{ message: string; meta?: unknown }> };
  return logger;
}

function stubProvider(generate: LLMProvider["generate"]): LLMProvider {
  return {
    name: "stub",
    model: "stub-model",
    generate,
    generateStream: async () => ({ content: "" }) as LLMResponse,
    supportsStreaming: () => false,
    isAvailable: async () => true,
  };
}

function writeToolFiles(
  root: string,
  name: string,
  opts: { script: string; parameters?: Record<string, unknown> | null; subagent?: boolean }
): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const frontmatterLines = ["---", `name: ${name}`, `description: "test tool ${name}"`, "core: false", "script: script.js"];
  if (opts.subagent) frontmatterLines.push("subagent: true");
  frontmatterLines.push("---", "", "Interpret the script result concisely.");
  writeFileSync(join(dir, "TOOL.md"), frontmatterLines.join("\n"), "utf8");
  writeFileSync(join(dir, "script.js"), opts.script, "utf8");
  if (opts.parameters !== null) {
    writeFileSync(
      join(dir, "parameters.json"),
      JSON.stringify(opts.parameters ?? { type: "object", properties: {} }),
      "utf8"
    );
  }
}

describe("script-tools", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ducki-script-tools-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("runs a script tool without a subagent and returns the raw result", async () => {
    writeToolFiles(root, "plain_math", { script: "return { sum: toolInput.a + toolInput.b };" });
    const generate = vi.fn();
    const logger = stubLogger();

    const tools = createScriptTools(() => stubProvider(generate), logger, root);
    expect(tools).toHaveLength(1);

    const result = await tools[0]!.execute({ a: 2, b: 3 });
    expect(result).toEqual({ success: true, data: { result: { sum: 5 }, logs: [] } });
    expect(generate).not.toHaveBeenCalled();
  });

  it("runs a script tool with a subagent and returns the interpreted result", async () => {
    writeToolFiles(root, "weather_summary", {
      script: "console.log('ran'); return { avg: 21 };",
      subagent: true,
    });
    const generate = vi.fn(async () => ({
      content: JSON.stringify({ summary: "Mild weather expected." }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));
    const logger = stubLogger();

    const tools = createScriptTools(() => stubProvider(generate), logger, root);
    expect(tools).toHaveLength(1);

    const result = await tools[0]!.execute({ station_id: "abc" });
    expect(result.success).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({
      interpreted: { summary: "Mild weather expected." },
      interpretedIsJson: true,
      result: { avg: 21 },
      logs: ["ran"],
    });
  });

  it("fails the tool call without invoking the subagent when the script throws", async () => {
    writeToolFiles(root, "broken_script", { script: "throw new Error('boom');", subagent: true });
    const generate = vi.fn();
    const logger = stubLogger();

    const tools = createScriptTools(() => stubProvider(generate), logger, root);
    const result = await tools[0]!.execute({});

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/boom/);
    expect(generate).not.toHaveBeenCalled();
  });

  it("fails soft when the subagent call itself fails - script result is still returned", async () => {
    writeToolFiles(root, "flaky_subagent", { script: "return { value: 42 };", subagent: true });
    const generate = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const logger = stubLogger();

    const tools = createScriptTools(() => stubProvider(generate), logger, root);
    const result = await tools[0]!.execute({});

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      result: { value: 42 },
      subagentFailed: true,
      subagentError: expect.stringContaining("provider unavailable"),
    });
  });

  it("skips a tool missing parameters.json and warns with the expected path", () => {
    writeToolFiles(root, "no_params", { script: "return 1;", parameters: null });
    const logger = stubLogger();

    const tools = createScriptTools(() => stubProvider(vi.fn()), logger, root);

    expect(tools).toHaveLength(0);
    expect(logger.warnCalls.some((c) => c.message.includes("parameters.json"))).toBe(true);
  });

  it("skips a script tool whose name collides with a reserved built-in tool", () => {
    writeToolFiles(root, "shell", { script: "return 1;" });
    const logger = stubLogger();

    const tools = createScriptTools(() => stubProvider(vi.fn()), logger, root);

    expect(tools).toHaveLength(0);
    expect(logger.warnCalls.some((c) => c.message.includes("reserved"))).toBe(true);
  });

  it("ignores manifests without any script (metadata-only TOOL.md)", () => {
    const dir = join(root, "metadata_only");
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + "/TOOL.md", ["---", "name: metadata_only", "core: true", "---", "", "no script here"].join("\n"), "utf8");

    const tools = createScriptTools(() => stubProvider(vi.fn()), stubLogger(), root);
    expect(tools).toHaveLength(0);
  });
});

describe("runScriptResultSubagent", () => {
  it("parses JSON content when the model returns valid JSON", async () => {
    const generate = vi.fn(async () => ({
      content: JSON.stringify({ ok: true }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));

    const output = await runScriptResultSubagent(() => stubProvider(generate), stubLogger(), {
      toolName: "demo",
      input: {},
      scriptResult: { x: 1 },
      logs: [],
    });

    expect(output.parsed).toEqual({ ok: true });
  });

  it("leaves parsed undefined when the model does not return JSON", async () => {
    const generate = vi.fn(async () => ({
      content: "just plain text",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));

    const output = await runScriptResultSubagent(() => stubProvider(generate), stubLogger(), {
      toolName: "demo",
      input: {},
      scriptResult: { x: 1 },
      logs: [],
    });

    expect(output.parsed).toBeUndefined();
    expect(output.content).toBe("just plain text");
  });

  it("rejects when the provider call exceeds the timeout", async () => {
    const generate = vi.fn(
      () => new Promise<LLMResponse>((resolvePromise) => setTimeout(() => resolvePromise({ content: "late" }), 50))
    );

    await expect(
      runScriptResultSubagent(() => stubProvider(generate), stubLogger(), {
        toolName: "demo",
        input: {},
        scriptResult: {},
        logs: [],
        timeoutMs: 5,
      })
    ).rejects.toThrow(/timed out/i);
  });
});
