import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@ducki/agent";
import type { BotSelect } from "@ducki/database";
import { BotService, MAIN_BOT_SLUG } from "./bot-service.js";

function bot(slug: string): BotSelect {
  return {
    slug,
    name: slug.toUpperCase(),
    description: null,
    avatar: null,
    systemPrompt: null,
    providerId: null,
    modelId: null,
    skillWhitelist: null,
    toolWhitelist: null,
    isBuiltIn: 0,
    conversationId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as BotSelect;
}

function makeHarness() {
  const bots = new Map<string, BotSelect>([
    [MAIN_BOT_SLUG, bot(MAIN_BOT_SLUG)],
    ["eddy", bot("eddy")],
    ["writer", bot("writer")],
  ]);

  const db = {
    getBot: vi.fn(async (slug: string) => bots.get(slug)),
    createConversation: vi.fn(async (input: any) => ({ id: Math.floor(Math.random() * 1000) + 1, ...input })),
    deleteConversation: vi.fn(async () => undefined),
    getSetting: vi.fn(async () => undefined),
    getMessages: vi.fn(async () => []),
    addMessage: vi.fn(async (input: any) => ({ id: 1, ...input })),
    tagMessage: vi.fn(async () => undefined),
    getConversation: vi.fn(async () => undefined),
    updateConversation: vi.fn(async () => undefined),
    updateBot: vi.fn(),
  } as any;

  const service = new BotService({
    db,
    providerRef: { current: {} as any },
    runtimeTools: [],
    pluginManager: { getTools: () => [] },
    createAgent: vi.fn(),
    createCodingAgentFactory: vi.fn(),
  });

  return { service, db, bots };
}

describe("BotService delegation (message_agent / delegate_task)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---- message_agent: deliverBotMessage ----

  it("delivers an attributed bot-to-bot DM into the target's own chat", async () => {
    const { service, db, bots } = makeHarness();
    const chat = vi.spyOn(service, "chat").mockResolvedValue({
      response: "Danke für die Nachricht!",
      conversationId: 5,
      stalled: false,
    });

    const outcome = await service.deliverBotMessage(bots.get(MAIN_BOT_SLUG)!, "eddy", "Bitte prüfe den Entwurf.");

    expect(outcome.delivered).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
    const [target, message] = chat.mock.calls[0]!;
    expect(target.slug).toBe("eddy");
    expect(message).toContain("Message from 🤖 MAIN");
    expect(message).toContain("@main");
    expect(message).toContain("Bitte prüfe den Entwurf.");
    expect(db.getBot).toHaveBeenCalledWith("eddy");
  });

  it("refuses to deliver to an unknown bot slug", async () => {
    const { service } = makeHarness();
    const chat = vi.spyOn(service, "chat");

    const outcome = await service.deliverBotMessage(bot("main"), "does-not-exist", "Hallo");

    expect(outcome.delivered).toBe(false);
    expect(outcome.error).toContain("does-not-exist");
    expect(chat).not.toHaveBeenCalled();
  });

  // ---- delegate_task: delegateTask ----

  it("runs subagents in isolated conversations, in input order, and deletes them afterwards", async () => {
    const { service, db } = makeHarness();
    const createAgentForBot = vi.spyOn(service, "createAgentForBot");
    const run = vi.fn(async (prompt: string) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { response: `done: ${prompt.slice(0, 20)}`, iterations: 1, toolsUsed: [], conversationId: 99 };
    });
    createAgentForBot.mockImplementation(async () => ({ loadConversation: vi.fn(), run } as unknown as Agent));

    const results = await service.delegateTask(bot("main"), [
      { goal: "Recherchiere X", context: "Kontext A" },
      { goal: "Schreibe Y" },
      { goal: "Prüfe Z" },
    ]);

    expect(results).toHaveLength(3);
    expect(results.map((result) => result.goal)).toEqual(["Recherchiere X", "Schreibe Y", "Prüfe Z"]);
    expect(results.every((result) => !result.stalled)).toBe(true);

    // Fresh conversation per task, all cleaned up again.
    expect(db.createConversation).toHaveBeenCalledTimes(3);
    expect(db.deleteConversation).toHaveBeenCalledTimes(3);
    const createdIds = db.createConversation.mock.results.map((result: any) => result.value.id);
    for (const id of createdIds) {
      expect(db.deleteConversation).toHaveBeenCalledWith(id);
    }

    // Every subagent is a leaf (isSubagent) and gets the prompt = context + goal.
    expect(createAgentForBot.mock.calls.every((call: any[]) => call[2]?.isSubagent === true)).toBe(true);
    expect(run).toHaveBeenCalledWith("Kontext A\n\nRecherchiere X");
    expect(run).toHaveBeenCalledWith("Schreibe Y");
  });

  it("limits parallel subagents to DELEGATION_MAX_CONCURRENT", async () => {
    const { service, db } = makeHarness();
    db.getSetting.mockImplementation(async (key: string) =>
      key === "DELEGATION_MAX_CONCURRENT" ? "2" : undefined
    );
    const createAgentForBot = vi.spyOn(service, "createAgentForBot");
    let active = 0;
    let peak = 0;
    createAgentForBot.mockImplementation(async () => ({
      loadConversation: vi.fn(),
      run: vi.fn(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active--;
        return { response: "ok", iterations: 1, toolsUsed: [], conversationId: 99 };
      }),
    } as unknown as Agent));

    await service.delegateTask(bot("main"), [
      { goal: "A" },
      { goal: "B" },
      { goal: "C" },
      { goal: "D" },
    ]);

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  it("uses DELEGATION_MODEL as the subagent model override", async () => {
    const { service, db } = makeHarness();
    db.getSetting.mockImplementation(async (key: string) =>
      key === "DELEGATION_MODEL" ? "openrouter/google/gemini-flash-2.0" : undefined
    );
    const createAgentForBot = vi.spyOn(service, "createAgentForBot");
    createAgentForBot.mockImplementation(async () => ({
      loadConversation: vi.fn(),
      run: vi.fn(async () => ({ response: "ok", iterations: 1, toolsUsed: [], conversationId: 99 })),
    } as unknown as Agent));

    await service.delegateTask(bot("main"), [{ goal: "A" }]);

    expect(createAgentForBot).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "main" }),
      undefined,
      expect.objectContaining({ isSubagent: true, modelId: "openrouter/google/gemini-flash-2.0" })
    );
  });
});
