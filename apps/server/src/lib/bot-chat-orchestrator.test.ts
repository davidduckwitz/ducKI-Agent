import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSelect } from "@ducki/database";

vi.mock("./shared-workspace-service.js", () => ({
  sharedWorkspace: {
    resolveGroupWorkspace: vi.fn(),
    getWorkspaceContext: vi.fn(() => ""),
  },
}));

import { BotChatOrchestrator } from "./bot-chat-orchestrator.js";

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

function makeDb(overrides: Record<string, string | undefined> = {}) {
  const defaults: Record<string, string | undefined> = {
    BOT_CHAT_MAX_ROUNDS: "6",
    BOT_CHAT_MAX_MESSAGES_PER_ROUND: "20",
    BOT_CHAT_PARALLEL_ENABLED: "true",
    BOT_CHAT_PARALLEL_MAX_CONCURRENT: "4",
    ...overrides,
  };
  return {
    getSetting: vi.fn(async (key: string) => defaults[key]),
    addMessage: vi.fn(async (row: any) => ({ id: 999, ...row })),
    tagMessage: vi.fn(async () => undefined),
  } as any;
}

function makeHandoff() {
  return {
    processMessageForHandoffs: vi.fn(async () => undefined),
    getHandoffContext: vi.fn(async () => ""),
  } as any;
}

describe("BotChatOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes every responder when a parallel round is larger than maxConcurrent", async () => {
    const slugs = Array.from({ length: 8 }, (_, index) => `bot-${index + 1}`);
    let active = 0;
    let peak = 0;
    const chat = vi.fn(async (current: BotSelect) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { response: `${current.slug} result`, conversationId: 1, stalled: false };
    });
    const botService = {
      getBot: vi.fn(async (slug: string) => bot(slug)),
      chat,
    } as any;
    const orchestrator = new BotChatOrchestrator(makeDb({ BOT_CHAT_PARALLEL_MAX_CONCURRENT: "4" }), botService, makeHandoff());

    const turns = await orchestrator.handleUserMessage(1, slugs, "Bitte bewertet die Aufgabe.");

    expect(chat).toHaveBeenCalledTimes(8);
    expect(new Set(turns.map((turn) => turn.botId))).toEqual(new Set(slugs));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("runs only explicitly mentioned participants in the initial round", async () => {
    const slugs = ["research", "coding", "docs"];
    const chat = vi.fn(async (current: BotSelect) => ({
      response: `${current.slug} result`, conversationId: 1, stalled: false,
    }));
    const botService = {
      getBot: vi.fn(async (slug: string) => bot(slug)),
      chat,
    } as any;
    const orchestrator = new BotChatOrchestrator(makeDb(), botService, makeHandoff());

    const turns = await orchestrator.handleUserMessage(1, slugs, "@research bitte suche die Ursache");

    expect(chat).toHaveBeenCalledTimes(1);
    expect(turns.map((turn) => turn.botId)).toEqual(["research"]);
  });

  it("waits for the user handoff write before the first bot turn starts", async () => {
    let handoffCommitted = false;
    const handoff = makeHandoff();
    handoff.processMessageForHandoffs.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      handoffCommitted = true;
    });
    const chat = vi.fn(async () => {
      expect(handoffCommitted).toBe(true);
      return { response: "done", conversationId: 1, stalled: false };
    });
    const botService = {
      getBot: vi.fn(async (slug: string) => bot(slug)),
      chat,
    } as any;
    const orchestrator = new BotChatOrchestrator(makeDb(), botService, handoff);

    await orchestrator.handleUserMessage(1, ["research"], "@research übernimm die Recherche");

    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("commits a bot handoff before starting the mentioned bot in the next round", async () => {
    let botHandoffCommitted = false;
    const handoff = makeHandoff();
    handoff.processMessageForHandoffs.mockImplementation(async (text: string, source: string) => {
      if (source === "a" && text.includes("@b")) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        botHandoffCommitted = true;
      }
    });

    const chat = vi.fn(async (current: BotSelect) => {
      if (current.slug === "a") {
        return { response: "@b übernimm bitte den zweiten Teil", conversationId: 1, stalled: false };
      }
      expect(botHandoffCommitted).toBe(true);
      return { response: "Teil erledigt", conversationId: 1, stalled: false };
    });
    const botService = {
      getBot: vi.fn(async (slug: string) => bot(slug)),
      chat,
    } as any;
    const orchestrator = new BotChatOrchestrator(makeDb(), botService, handoff);

    const turns = await orchestrator.handleUserMessage(1, ["a", "b"], "@a starte");

    expect(turns.map((turn) => turn.botId)).toEqual(["a", "b"]);
    expect(botHandoffCommitted).toBe(true);
  });

  it("does not open another round for a pass response", async () => {
    const chat = vi.fn(async () => ({ response: "(pass)", conversationId: 1, stalled: false }));
    const botService = {
      getBot: vi.fn(async (slug: string) => bot(slug)),
      chat,
    } as any;
    const orchestrator = new BotChatOrchestrator(makeDb(), botService, makeHandoff());

    const turns = await orchestrator.handleUserMessage(1, ["a", "b"], "Frage an alle");

    expect(chat).toHaveBeenCalledTimes(2);
    expect(turns.every((turn) => turn.passed)).toBe(true);
  });

  it("serializes initial responders when the user explicitly requests an order", async () => {
    let active = 0;
    let peak = 0;
    const chat = vi.fn(async (current: BotSelect) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 4));
      active--;
      return { response: `${current.slug} result`, conversationId: 1, stalled: false };
    });
    const botService = {
      getBot: vi.fn(async (slug: string) => bot(slug)),
      chat,
    } as any;
    const orchestrator = new BotChatOrchestrator(makeDb(), botService, makeHandoff());

    await orchestrator.handleUserMessage(1, ["a", "b", "c"], "@a zuerst prüfen, danach @b und dann @c");

    expect(chat).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });
});
