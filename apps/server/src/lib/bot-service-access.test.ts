import { describe, expect, it, vi } from "vitest";
import { BotService } from "./bot-service.js";

function baseDeps(db: any, runtimeTools: any[] = []) {
  return {
    db,
    providerRef: {
      current: {
        generate: vi.fn(),
        stream: vi.fn(),
        supportsNativeTools: () => true,
      } as any,
    },
    runtimeTools,
    pluginManager: { getTools: () => [] },
    createAgent: vi.fn(),
    createCodingAgentFactory: vi.fn(),
  } as any;
}

function customBot(overrides: Record<string, unknown> = {}) {
  return {
    slug: "custom",
    name: "Custom",
    description: null,
    avatar: null,
    systemPrompt: "You are Custom",
    providerId: null,
    modelId: null,
    skillWhitelist: null,
    toolWhitelist: null,
    isBuiltIn: 0,
    conversationId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as any;
}

const probeTool = {
  name: "runtime_probe",
  description: "test probe",
  definition: {
    type: "function",
    function: { name: "runtime_probe", description: "test probe", parameters: { type: "object", properties: {} } },
  },
  execute: vi.fn(async () => ({ success: true, data: "ok" })),
} as any;

describe("BotService access policy", () => {
  it("stores new bots fail-closed when skills/tools are omitted", async () => {
    const createBot = vi.fn(async (row: any) => ({ id: 1, ...row }));
    const db = {
      getBot: vi.fn(async () => undefined),
      createBot,
    } as any;
    const service = new BotService(baseDeps(db));

    await service.createBot({ name: "Safe Bot" });

    expect(createBot).toHaveBeenCalledWith(expect.objectContaining({
      skillWhitelist: "[]",
      toolWhitelist: "[]",
      isBuiltIn: 0,
    }));
  });

  it("stores explicit wildcard access without converting it to legacy null", async () => {
    const createBot = vi.fn(async (row: any) => ({ id: 1, ...row }));
    const db = {
      getBot: vi.fn(async () => undefined),
      createBot,
    } as any;
    const service = new BotService(baseDeps(db));

    await service.createBot({ name: "Full Bot", skillWhitelist: ["*"], toolWhitelist: ["*"] });

    expect(createBot).toHaveBeenCalledWith(expect.objectContaining({
      skillWhitelist: JSON.stringify(["*"]),
      toolWhitelist: JSON.stringify(["*"]),
    }));
  });

  it("does not change legacy permissions when an edit omits access fields", async () => {
    const legacy = customBot({ skillWhitelist: null, toolWhitelist: null });
    const updateBot = vi.fn(async (_slug: string, patch: any) => ({ ...legacy, ...patch }));
    const db = {
      getBot: vi.fn(async () => legacy),
      updateBot,
    } as any;
    const service = new BotService(baseDeps(db));

    await service.updateBot("custom", { description: "new description" });

    const patch = updateBot.mock.calls[0]![1];
    expect(patch.description).toBe("new description");
    expect(patch).not.toHaveProperty("skillWhitelist");
    expect(patch).not.toHaveProperty("toolWhitelist");
  });

  it("treats legacy null as unrestricted but explicit [] as no runtime tool access", async () => {
    const db = {
      getSetting: vi.fn(async () => undefined),
    } as any;
    const service = new BotService(baseDeps(db, [probeTool]));

    const legacyAgent = await service.createAgentForBot(customBot({ toolWhitelist: null }));
    const lockedAgent = await service.createAgentForBot(customBot({ toolWhitelist: "[]" }));
    const wildcardAgent = await service.createAgentForBot(customBot({ toolWhitelist: JSON.stringify(["*"]) }));

    expect(legacyAgent.executor.listTools().some((tool: any) => tool.name === "runtime_probe")).toBe(true);
    expect(lockedAgent.executor.listTools().some((tool: any) => tool.name === "runtime_probe")).toBe(false);
    expect(wildcardAgent.executor.listTools().some((tool: any) => tool.name === "runtime_probe")).toBe(true);
  });

  it("fails closed for malformed stored access JSON", async () => {
    const db = { getSetting: vi.fn(async () => undefined) } as any;
    const service = new BotService(baseDeps(db, [probeTool]));

    const agent = await service.createAgentForBot(customBot({ toolWhitelist: "not-json" }));

    expect(agent.executor.listTools().some((tool: any) => tool.name === "runtime_probe")).toBe(false);
  });
});
