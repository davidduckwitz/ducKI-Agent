import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudControlDeps } from "./cloud-control.js";

vi.mock("./audio-transcription.js", () => ({
  transcribeAudioBuffer: vi.fn(async () => "Team, wir sollten erst einen Plan machen."),
}));

import { dispatchCommand } from "./cloud-control.js";

function makeDeps(overrides: Partial<CloudControlDeps> = {}) {
  const db = {
    getSetting: vi.fn(async () => undefined),
    getMessageCount: vi.fn(async () => 42),
  };
  const runTeamChat = vi.fn(async (message: string, options?: { mode?: "plan" | "execute" }) => ({
    response: "team reply",
    conversationId: 7,
    turns: [
      { round: 1, botId: "main", botName: "Main", content: "Vorschlag", passed: false, needsUserDecision: false },
      { round: 1, botId: "eddy", botName: "Eddy", content: "(pass)", passed: true, needsUserDecision: false },
    ],
    needsUserDecision: false,
    stalled: false,
  }));
  const deps = {
    db,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    requestPluginReload: vi.fn(),
    createAgent: vi.fn(),
    runTeamChat,
    ...overrides,
  } as unknown as CloudControlDeps;
  return { deps, db, runTeamChat };
}

describe("cloud-control team routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes bot.chat.send through runTeamChat and returns per-bot turns", async () => {
    const { deps, runTeamChat } = makeDeps();

    const outcome = await dispatchCommand(deps, {
      id: 1,
      type: "bot.chat.send",
      payload: { message: "Wir sollten erst einen Plan machen." },
    });

    expect(runTeamChat).toHaveBeenCalledTimes(1);
    expect(runTeamChat).toHaveBeenCalledWith("Wir sollten erst einen Plan machen.", undefined);
    expect(outcome.status).toBe("done");
    expect(outcome.result).toMatchObject({
      reply: "team reply",
      botConversationId: 7,
      contextMessageCount: 42,
      turns: [
        { botId: "main", content: "Vorschlag", passed: false },
        { botId: "eddy", passed: true },
      ],
    });
  });

  it("passes an explicit mode from the payload through to runTeamChat", async () => {
    const { deps, runTeamChat } = makeDeps();

    await dispatchCommand(deps, {
      id: 2,
      type: "bot.chat.send",
      payload: { message: "Mach einfach los.", mode: "plan" },
    });

    expect(runTeamChat).toHaveBeenCalledWith("Mach einfach los.", { mode: "plan" });
  });

  it("rejects unknown modes and lets the orchestrator auto-detect", async () => {
    const { deps, runTeamChat } = makeDeps();

    await dispatchCommand(deps, {
      id: 3,
      type: "bot.chat.send",
      payload: { message: "Hallo", mode: "nonsense" },
    });

    expect(runTeamChat).toHaveBeenCalledWith("Hallo", undefined);
  });

  it("fails cleanly when runTeamChat is unavailable", async () => {
    const { deps } = makeDeps({ runTeamChat: undefined });

    const outcome = await dispatchCommand(deps, {
      id: 4,
      type: "bot.chat.send",
      payload: { message: "Hallo" },
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.result?.error).toContain("Team-Chat");
  });

  it("routes a team-mode voice.transcribe through runTeamChat after transcription", async () => {
    const { deps, runTeamChat } = makeDeps();

    const outcome = await dispatchCommand(deps, {
      id: 5,
      type: "voice.transcribe",
      payload: { audio: Buffer.from("fake-audio").toString("base64"), mode: "team" },
    });

    expect(runTeamChat).toHaveBeenCalledTimes(1);
    // Ohne chatMode bleibt die Absicht undefined -> der Orchestrator erkennt sie selbst.
    expect(runTeamChat).toHaveBeenCalledWith("Team, wir sollten erst einen Plan machen.", undefined);
    expect(outcome.status).toBe("done");
    expect(outcome.result).toMatchObject({
      transcript: "Team, wir sollten erst einen Plan machen.",
      reply: "team reply",
      turns: expect.any(Array),
    });
  });

  it("forwards an explicit chatMode to runTeamChat for bot.chat.send", async () => {
    const { deps, runTeamChat } = makeDeps();

    await dispatchCommand(deps, {
      id: 6,
      type: "bot.chat.send",
      payload: { message: "Setzt es um", chatMode: "execute" },
    });

    expect(runTeamChat).toHaveBeenCalledWith("Setzt es um", { mode: "execute" });
  });

  it("keeps the legacy mode key working as a back-compat alias for bot.chat.send", async () => {
    const { deps, runTeamChat } = makeDeps();

    await dispatchCommand(deps, {
      id: 7,
      type: "bot.chat.send",
      payload: { message: "Plant das mal", mode: "plan" },
    });

    expect(runTeamChat).toHaveBeenCalledWith("Plant das mal", { mode: "plan" });
  });

  it("forwards chatMode from a team-mode voice.transcribe", async () => {
    const { deps, runTeamChat } = makeDeps();

    const outcome = await dispatchCommand(deps, {
      id: 8,
      type: "voice.transcribe",
      payload: { audio: Buffer.from("fake-audio").toString("base64"), mode: "team", chatMode: "plan" },
    });

    expect(runTeamChat).toHaveBeenCalledWith("Team, wir sollten erst einen Plan machen.", { mode: "plan" });
    expect(outcome.status).toBe("done");
  });
});
