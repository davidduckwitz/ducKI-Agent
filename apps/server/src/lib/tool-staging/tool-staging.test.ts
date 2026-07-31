import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutor, ToolResult } from "@ducki/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolStagingManager } from "./tool-staging-manager.js";
import { initToolResponseHandler } from "./tool-response-handler.js";
import { createToolStagingTool } from "./tool-staging-tool.js";
import { createToolWrapper } from "../tool-wrapper.js";

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
} as unknown as ConstructorParameters<typeof ToolStagingManager>[0];

/** Comfortably above the handler's 5KB staging threshold. */
const BIG = "x".repeat(20_000);

function fakeTool(name: string, data: unknown): ToolExecutor {
  return {
    name,
    description: name,
    definition: { name, description: name, parameters: {} },
    execute: async (): Promise<ToolResult> => ({ success: true, data }),
  };
}

describe("tool staging", () => {
  let dir: string;
  let manager: ToolStagingManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "ducki-staging-"));
    manager = new ToolStagingManager(noopLogger, dir);
    await fs.mkdir(dir, { recursive: true });
    initToolResponseHandler(noopLogger, manager);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps string payloads readable instead of replacing them with markers", async () => {
    const wrapped = createToolWrapper(fakeTool("shell", BIG));
    const result = await wrapped.execute({});

    expect(typeof result.data).toBe("string");
    const text = result.data as string;
    // The head of the real output survives - the old wrapper dropped it entirely.
    expect(text.startsWith("xxxx")).toBe(true);
    expect(text).toContain("[FULL RESULT AVAILABLE");
    expect(text).toContain("tool_staging");
    expect(text).toMatch(/"id":"[0-9a-f-]{36}"/);
  });

  it("keeps object payload keys and appends a resolvable staging pointer", async () => {
    const wrapped = createToolWrapper(fakeTool("http", { url: "https://example.com", body: BIG }));
    const result = await wrapped.execute({});

    const data = result.data as Record<string, unknown>;
    expect(data["url"]).toBe("https://example.com");
    expect(typeof data["__toolStagingId"]).toBe("string");
    expect(String(data["__toolStagingHint"])).toContain("tool_staging");
  });

  it("reads a staged response back in chunks", async () => {
    const wrapped = createToolWrapper(fakeTool("http", { body: BIG }));
    const staged = (await wrapped.execute({})).data as Record<string, unknown>;
    const id = String(staged["__toolStagingId"]);

    const tool = createToolStagingTool(() => manager);
    const first = await tool.execute({ action: "read", id, limit: 500 });
    expect(first.success).toBe(true);

    const page = first.data as Record<string, unknown>;
    expect(page["hasMore"]).toBe(true);
    expect(String(page["content"]).length).toBe(500);
    expect(page["nextOffset"]).toBe(500);

    const second = await tool.execute({ action: "read", id, offset: page["nextOffset"], limit: 500 });
    const page2 = second.data as Record<string, unknown>;
    expect(page2["offset"]).toBe(500);
    expect(String(page2["content"]).length).toBe(500);
  });

  it("finds content via search and can delete the staged file", async () => {
    const staged = await manager.stageToolResponse("http", `noise\nNEEDLE-HERE\n${BIG}`, "summary");
    const tool = createToolStagingTool(() => manager);

    const found = await tool.execute({ action: "read", id: staged.id, search: "NEEDLE-HERE" });
    const data = found.data as Record<string, unknown>;
    expect(data["matchCount"]).toBe(1);

    const listed = (await tool.execute({ action: "list" })).data as Record<string, unknown>;
    expect(listed["count"]).toBe(1);

    expect((await tool.execute({ action: "delete", id: staged.id })).success).toBe(true);
    expect(await manager.listStaged()).toEqual([]);
  });

  it("reports a clear error for an expired or unknown id", async () => {
    const tool = createToolStagingTool(() => manager);
    const result = await tool.execute({ action: "read", id: "00000000-0000-0000-0000-000000000000" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found or expired");
  });

  it("never stages its own output", async () => {
    const tool = createToolStagingTool(() => manager);
    const staged = await manager.stageToolResponse("http", BIG, "summary");
    const wrappedStagingTool = createToolWrapper(tool);

    const result = await wrappedStagingTool.execute({ action: "read", id: staged.id, limit: 3800 });
    const data = result.data as Record<string, unknown>;
    expect(data["__toolStagingId"]).toBeUndefined();
    expect(String(data["content"]).length).toBe(3800);
  });
});
