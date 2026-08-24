import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentRunResult, AgentRunOptions, CodingAgent } from "@ducki/agent";
import type { BotSelect } from "@ducki/database";
import { BotService, MAIN_BOT_SLUG } from "./bot-service.js";

function mainBot(): BotSelect {
  return {
    slug: MAIN_BOT_SLUG,
    name: "DucKI",
    description: null,
    avatar: null,
    systemPrompt: null,
    providerId: null,
    modelId: null,
    skillWhitelist: null,
    toolWhitelist: null,
    isBuiltIn: 1,
    conversationId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as BotSelect;
}

type FakeMessage = {
  id: number;
  conversationId: number;
  role: string;
  content: string;
  metadata: string | null;
  authorBotId?: string | null;
};

function makeHarness(runResponses: string[]) {
  let nextId = 1;
  const rows: FakeMessage[] = [
    { id: nextId++, conversationId: 7, role: "user", content: "real user message", metadata: null },
  ];

  const db = {
    getMessages: vi.fn(async () => rows.map((row) => ({ ...row }))),
    addMessage: vi.fn(async (input: any) => {
      const row: FakeMessage = {
        id: nextId++,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        metadata: input.metadata ?? null,
        authorBotId: input.authorBotId ?? null,
      };
      rows.push(row);
      return { ...row };
    }),
    tagMessage: vi.fn(async (id: number, patch: { metadata?: string }) => {
      const row = rows.find((entry) => entry.id === id);
      if (row && patch.metadata !== undefined) row.metadata = patch.metadata;
      return row ? { ...row } : undefined;
    }),
    getSetting: vi.fn(async () => undefined),
    getConversation: vi.fn(async () => ({ id: 7, name: "group", origin: "bot_chat" })),
    updateConversation: vi.fn(async () => undefined),
    createConversation: vi.fn(),
    updateBot: vi.fn(),
  } as any;

  let responseIndex = 0;
  const loadConversation = vi.fn(async () => undefined);
  const run = vi.fn(async (_prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> => {
    // Mirror the important persistence behavior of Agent.run(): its synthetic user prompt is
    // written with the caller-provided localMessageId. Put an unrelated parallel prompt beside
    // it to prove BotService later claims rows by ownership id instead of by DB insertion order.
    const localMessageId = options.localMessageId;
    await db.addMessage({
      conversationId: 7,
      role: "user",
      content: `internal-${responseIndex + 1}`,
      metadata: localMessageId ? JSON.stringify({ localMessageId }) : null,
    });
    if (responseIndex === 0) {
      await db.addMessage({
        conversationId: 7,
        role: "user",
        content: "foreign parallel bot prompt",
        metadata: JSON.stringify({ localMessageId: "foreign-bot-prompt" }),
      });
    }

    const response = runResponses[Math.min(responseIndex, runResponses.length - 1)] ?? "done";
    responseIndex++;
    return {
      response,
      iterations: 1,
      toolsUsed: [],
      conversationId: 7,
    };
  });

  const preparedAgent = { loadConversation, run } as unknown as Agent;
  const createAgent = vi.fn(async () => preparedAgent);
  const service = new BotService({
    db,
    providerRef: { current: {} as any },
    runtimeTools: [],
    pluginManager: { getTools: () => [] },
    createAgent,
    createCodingAgentFactory: vi.fn(() => ({} as CodingAgent)),
  });

  return { service, db, rows, preparedAgent, createAgent, loadConversation, run };
}

describe("BotService prepared group turns", () => {
  it("does not reload a prepared Agent and keeps stall recovery on the frozen pre-round snapshot", async () => {
    const harness = makeHarness(["Ich werde die Recherche durchführen.", "Fertiges Ergebnis"]);
    const current = mainBot();

    const prepared = await harness.service.prepareAgentForGroupTurn(current, 7);
    expect(prepared).toBe(harness.preparedAgent);
    expect(harness.createAgent).toHaveBeenCalledTimes(1);
    expect(harness.loadConversation).toHaveBeenCalledTimes(1);
    expect(harness.loadConversation).toHaveBeenCalledWith(7);

    const result = await harness.service.chat(current, "synthetic group prompt", {
      conversationId: 7,
      tagPromptAsInternal: true,
      preparedAgent: prepared,
    });

    expect(result.response).toBe("Fertiges Ergebnis");
    expect(result.stalled).toBe(false);
    expect(harness.run).toHaveBeenCalledTimes(2);
    // The key invariant: no mid-round load after a peer could already have persisted a reply.
    expect(harness.loadConversation).toHaveBeenCalledTimes(1);
    expect(harness.createAgent).toHaveBeenCalledTimes(1);

    const firstOptions = harness.run.mock.calls[0]?.[1] as AgentRunOptions;
    const secondOptions = harness.run.mock.calls[1]?.[1] as AgentRunOptions;
    expect(firstOptions.localMessageId).toBeTruthy();
    expect(secondOptions.localMessageId).toBe(firstOptions.localMessageId);
  });

  it("tags only synthetic prompt rows owned by this bot turn and preserves their metadata", async () => {
    const harness = makeHarness(["done"]);
    const current = mainBot();
    const prepared = await harness.service.prepareAgentForGroupTurn(current, 7);

    await harness.service.chat(current, "synthetic group prompt", {
      conversationId: 7,
      tagPromptAsInternal: true,
      preparedAgent: prepared,
    });

    const options = harness.run.mock.calls[0]?.[1] as AgentRunOptions;
    const localMessageId = options.localMessageId;
    expect(localMessageId).toBeTruthy();

    const ownedRows = harness.rows.filter((row) => {
      if (!row.metadata) return false;
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      return meta.localMessageId === localMessageId;
    });
    expect(ownedRows).toHaveLength(1);
    expect(JSON.parse(ownedRows[0]!.metadata!) as Record<string, unknown>).toMatchObject({
      localMessageId,
      internal: true,
    });

    const foreign = harness.rows.find((row) => row.content === "foreign parallel bot prompt");
    expect(foreign).toBeDefined();
    expect(JSON.parse(foreign!.metadata!) as Record<string, unknown>).toEqual({
      localMessageId: "foreign-bot-prompt",
    });

    const taggedIds = harness.db.tagMessage.mock.calls.map((call: any[]) => call[0]);
    expect(taggedIds).toEqual(ownedRows.map((row) => row.id));
  });
});
