import { describe, expect, it, vi } from "vitest";
import { createDelegateToBotTool } from "./delegate-to-bot-tool.js";

const specialists = [
  { slug: "frontend-developer", name: "Frontend Developer", description: "UI" },
  { slug: "backend-infrastructure", name: "Backend Infrastructure", description: "Backend" },
  { slug: "custom", name: "Custom", description: "Other" },
];

describe("coding delegate_to_bot", () => {
  it("lists only coding specialists", async () => {
    const service = { listBots: vi.fn(async () => specialists) } as any;
    const tool = createDelegateToBotTool(() => service, { mode: "coding", sandboxRoot: "C:/project" });

    const result = await tool.execute({ action: "list" });

    expect(result.success).toBe(true);
    expect((result.data as any).bots.map((bot: any) => bot.slug)).toEqual([
      "frontend-developer",
      "backend-infrastructure",
    ]);
  });

  it("is enabled by default but honors the persisted opt-out", async () => {
    const service = { listBots: vi.fn(async () => specialists) } as any;
    const disabled = createDelegateToBotTool(() => service, {
      mode: "coding",
      isEnabled: async () => false,
    });

    const result = await disabled.execute({ action: "list" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("disabled");
    expect(service.listBots).not.toHaveBeenCalled();
  });

  it("waits for a specialist and passes the coding workspace context", async () => {
    const chatIsolated = vi.fn(async () => ({ response: "done", stalled: false }));
    const service = {
      getBot: vi.fn(async (slug: string) => specialists.find((bot) => bot.slug === slug)),
      chatIsolated,
    } as any;
    const tool = createDelegateToBotTool(() => service, {
      mode: "coding",
      sandboxRoot: "C:/project",
      isEnabled: async () => true,
    });

    const result = await tool.execute({
      action: "run",
      botId: "frontend-developer",
      task: "Style the page",
      files: ["src/page.css"],
      acceptanceCriteria: ["Responsive"],
      verifyCommand: "npm test",
    });

    expect(result.success).toBe(true);
    expect(chatIsolated).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "frontend-developer" }),
      expect.stringContaining("src/page.css"),
      { sandboxRoot: "C:/project" }
    );
  });

  it("blocks arbitrary bots and recursive delegation to CodingAgent", async () => {
    const service = { getBot: vi.fn() } as any;
    const tool = createDelegateToBotTool(() => service, { mode: "coding" });

    const custom = await tool.execute({ action: "run", botId: "custom", task: "work" });
    const coding = await tool.execute({ action: "run", botId: "coding", task: "work" });

    expect(custom.success).toBe(false);
    expect(coding.success).toBe(false);
    expect(service.getBot).not.toHaveBeenCalled();
  });
});
