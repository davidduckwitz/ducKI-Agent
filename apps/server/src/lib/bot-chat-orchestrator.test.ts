import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotSelect } from "@ducki/database";

vi.mock("./shared-workspace-service.js", () => ({
  sharedWorkspace: {
    resolveGroupWorkspace: vi.fn(),
    getWorkspaceContext: vi.fn(() => ""),
  },
}));

import { BotChatOrchestrator } from "./bot-chat-orchestrator.js";
import { sharedWorkspace } from "./shared-workspace-service.js";

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

  it("executes every responder in a serial broadcast", async () => {
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
    // Broadcasts are SERIAL (Hermes Bot-Mode order): one bot at a time, each seeing the previous
    // bot's response before deciding to speak or pass.
    expect(peak).toBe(1);
  });

  it("runs a serial broadcast without engaging the batch snapshot barrier", async () => {
    const slugs = Array.from({ length: 8 }, (_, index) => `bot-${index + 1}`);
    const prepareAgentForGroupTurn = vi.fn(async () => undefined);
    const chat = vi.fn(async (current: BotSelect) => ({
      response: `${current.slug} result`, conversationId: 1, stalled: false,
    }));
    const botService = {
      getBot: vi.fn(async (slug: string) => bot(slug)),
      prepareAgentForGroupTurn,
      chat,
    } as any;
    const orchestrator = new BotChatOrchestrator(
      makeDb({ BOT_CHAT_PARALLEL_MAX_CONCURRENT: "4" }),
      botService,
      makeHandoff()
    );

    await orchestrator.handleUserMessage(1, slugs, "Bitte bewertet die Aufgabe.");

    expect(chat).toHaveBeenCalledTimes(8);
    // Every broadcast batch holds exactly one bot, so the immutable-snapshot barrier (which only
    // engages for batch.length > 1) is never used in the serial flow.
    expect(prepareAgentForGroupTurn).not.toHaveBeenCalled();
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

  it("never overlaps CodingAgent with another participant", async () => {
    const slugs = ["a", "b", "coding", "c", "d"];
    const active = new Set<string>();
    let codingOverlap = false;

    const chat = vi.fn(async (current: BotSelect) => {
      active.add(current.slug);
      if (current.slug === "coding" && active.size > 1) codingOverlap = true;
      if (current.slug !== "coding" && active.has("coding")) codingOverlap = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active.delete(current.slug);
      return { response: `${current.slug} result`, conversationId: 1, stalled: false };
    });
    const botService = {
      getBot: vi.fn(async (slug: string) => bot(slug)),
      chat,
    } as any;
    const orchestrator = new BotChatOrchestrator(makeDb(), botService, makeHandoff());

    await orchestrator.handleUserMessage(1, slugs, "Bitte arbeitet an der Aufgabe.");

    expect(chat).toHaveBeenCalledTimes(5);
    expect(codingOverlap).toBe(false);
  });

  it("in a serial broadcast the first speaker's mention wins deterministically", async () => {
    let cPrompt = "";
    const chat = vi.fn(async (current: BotSelect, prompt: string) => {
      if (current.slug === "a") {
        return { response: "@c übernimm den nächsten Schritt", conversationId: 1, stalled: false };
      }
      if (current.slug === "b") {
        return { response: "@c prüfe das ebenfalls", conversationId: 1, stalled: false };
      }
      cPrompt = prompt;
      return { response: "fertig", conversationId: 1, stalled: false };
    });
    const botService = {
      getBot: vi.fn(async (slug: string) => bot(slug)),
      chat,
    } as any;
    const orchestrator = new BotChatOrchestrator(makeDb(), botService, makeHandoff());

    await orchestrator.handleUserMessage(1, ["a", "b", "c"], "@a @b bitte parallel prüfen");

    // A and B are serialized (a, then b); C's trigger keeps the FIRST speaker that mentioned it
    // (deterministic speaking order, not completion timing).
    expect(cPrompt).toContain("A mentioned you (@C)");
    expect(cPrompt).not.toContain("B mentioned you (@C)");
  });

  it("treats a German planning request as a no-tools discussion and synthesizes a plan", async () => {
    const chat = vi.fn(async (current: BotSelect, _prompt: string, opts: any) => {
      expect(opts.noTools).toBe(true);
      expect(opts.groupProtocol).toContain("GROUP CHAT");
      return { response: `${current.slug}: Mein Vorschlag`, conversationId: 1, stalled: false };
    });
    const synthesizeTeamPlan = vi.fn(async () => ({
      content: "## 📋 Gemeinsamer Plan\n\n1. Schritt",
      path: "/tmp/workspace/plan-1.md",
      messageId: 42,
    }));
    const botService = {
      getBot: vi.fn(async (slug: string) => bot(slug)),
      chat,
      synthesizeTeamPlan,
    } as any;
    const orchestrator = new BotChatOrchestrator(makeDb(), botService, makeHandoff());

    const turns = await orchestrator.handleUserMessage(
      1,
      ["main", "coding", "frontend-developer", "backend-infrastructure"],
      "Lass uns erst einen Plan machen, bevor wir irgendetwas ändern."
    );

    // Coding bot AND coding specialists are excluded from a discussion round: only main speaks.
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]![0].slug).toBe("main");
    expect(turns.map((turn) => turn.botId)).toEqual(["main", "main"]);

    const planTurn = turns.find((turn) => turn.isPlan);
    expect(planTurn).toBeTruthy();
    expect(planTurn!.content).toContain("Gemeinsamer Plan");
    expect(planTurn!.planPath).toBe("/tmp/workspace/plan-1.md");
    expect(synthesizeTeamPlan).toHaveBeenCalledWith(
      "Lass uns erst einen Plan machen, bevor wir irgendetwas ändern.",
      1,
      expect.objectContaining({ slug: "main" })
    );
  });

  it("forces a discussion on mode 'plan' and full tool access on mode 'execute'", async () => {
    const chat = vi.fn(async (current: BotSelect) => ({
      response: "Antwort", conversationId: 1, stalled: false,
    }));
    const synthesizeTeamPlan = vi.fn(async () => ({ content: "Plan", path: "/p", messageId: 1 }));
    const botService = {
      getBot: vi.fn(async (slug: string) => bot(slug)),
      chat,
      synthesizeTeamPlan,
    } as any;
    const orchestrator = new BotChatOrchestrator(makeDb(), botService, makeHandoff());

    // Execution-sounding message, but forced plan mode -> no-tools discussion + plan artifact.
    const planned = await orchestrator.handleUserMessage(
      1, ["a", "b"], "Bitte bau die Funktion sofort ein.", undefined, { mode: "plan" }
    );
    expect(chat.mock.calls[0]![2].noTools).toBe(true);
    expect(planned.some((turn) => turn.isPlan)).toBe(true);

    chat.mockClear();
    synthesizeTeamPlan.mockClear();

    // Planning-sounding message, but forced execute mode -> tools available, no plan artifact.
    const executed = await orchestrator.handleUserMessage(
      1, ["a", "b"], "Wir sollten einen Plan machen.", undefined, { mode: "execute" }
    );
    expect(chat.mock.calls[0]![2].noTools).toBeFalsy();
    expect(executed.some((turn) => turn.isPlan)).toBe(false);
    expect(synthesizeTeamPlan).not.toHaveBeenCalled();
  });

  it("injects the latest plan from the group workspace into execution rounds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ducki-plan-"));
    const outputDir = join(dir, "output");
    mkdirSync(outputDir, { recursive: true });
    const planPath = join(outputDir, "plan-refactor-1.md");
    writeFileSync(planPath, "# Refactor Plan\n\n1. Step A\n2. Step B", "utf8");
    vi.mocked(sharedWorkspace.resolveGroupWorkspace).mockReturnValue(dir);

    let prompt = "";
    const chat = vi.fn(async (current: BotSelect, p: string) => {
      prompt += p;
      return { response: "Antwort", conversationId: 1, stalled: false };
    });
    const botService = {
      getBot: vi.fn(async (slug: string) => bot(slug)),
      chat,
    } as any;
    const orchestrator = new BotChatOrchestrator(makeDb(), botService, makeHandoff());

    await orchestrator.handleUserMessage(1, ["a"], "Führe die Implementierung jetzt aus.");

    expect(chat).toHaveBeenCalledTimes(1);
    // The plan artifact is injected as an explicit execution context section...
    expect(prompt).toContain("# Refactor Plan");
    expect(prompt).toContain("Plan file:");
    expect(prompt).toContain("EXECUTE this plan now");
    // ...and the round guidelines switch from discuss-and-claim to actual execution.
    expect(prompt).toContain("EXECUTE an approved plan");

    rmSync(dir, { recursive: true, force: true });
    vi.mocked(sharedWorkspace.resolveGroupWorkspace).mockReset();
  });

  it("treats 'setz den Plan um' as execution intent, not a new planning round", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ducki-plan-"));
    const outputDir = join(dir, "output");
    mkdirSync(outputDir, { recursive: true });
    const planPath = join(outputDir, "plan-migration-2.md");
    writeFileSync(planPath, "# Migration Plan\n\nMove to v2.", "utf8");
    vi.mocked(sharedWorkspace.resolveGroupWorkspace).mockReturnValue(dir);

    let prompt = "";
    const chat = vi.fn(async (current: BotSelect, p: string, opts: any) => {
      prompt += p;
      return { response: "Antwort", conversationId: 1, stalled: false };
    });
    const botService = {
      getBot: vi.fn(async (slug: string) => bot(slug)),
      chat,
    } as any;
    const orchestrator = new BotChatOrchestrator(makeDb(), botService, makeHandoff());

    await orchestrator.handleUserMessage(1, ["a"], "Setzt den Plan jetzt um.");

    // "Plan" alone would normally trigger planning mode - the execution verb overrides it:
    // tools stay available (noTools falsy) and the existing plan is injected for execution.
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]![2].noTools).toBeFalsy();
    expect(prompt).toContain("# Migration Plan");
    expect(prompt).not.toContain("Tools are DISABLED for this turn");

    rmSync(dir, { recursive: true, force: true });
    vi.mocked(sharedWorkspace.resolveGroupWorkspace).mockReset();
  });

  it("detects German brainstorming vocabulary as planning intent", async () => {
    const chat = vi.fn(async () => ({ response: "Antwort", conversationId: 1, stalled: false }));
    const synthesizeTeamPlan = vi.fn(async () => ({ content: "Plan", path: "/p", messageId: 1 }));
    const botService = {
      getBot: vi.fn(async (slug: string) => bot(slug)),
      chat,
      synthesizeTeamPlan,
    } as any;
    const orchestrator = new BotChatOrchestrator(makeDb(), botService, makeHandoff());

    await orchestrator.handleUserMessage(1, ["a"], "Wie wäre unser Vorgehen beim Refactoring?");
    expect(chat.mock.calls[0]![2].noTools).toBe(true);
    expect(synthesizeTeamPlan).toHaveBeenCalled();

    chat.mockClear();
    synthesizeTeamPlan.mockClear();

    // Explicitly executional phrasing stays out of planning mode.
    await orchestrator.handleUserMessage(1, ["a"], "Führe die Migration jetzt bitte aus.");
    expect(chat.mock.calls[0]![2].noTools).toBeFalsy();
    expect(synthesizeTeamPlan).not.toHaveBeenCalled();
  });
});
