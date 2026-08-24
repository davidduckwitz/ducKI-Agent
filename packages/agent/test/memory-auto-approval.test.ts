import { describe, expect, it, vi } from "vitest";
import { MemorySystem } from "../src/memory/memory";

function createMemory(setting?: string) {
  const addMemory = vi.fn().mockResolvedValue({});
  const db = {
    getMemories: vi.fn().mockResolvedValue([]),
    getSetting: vi.fn().mockResolvedValue(setting),
    addMemory,
  } as any;
  const logger = { debug: vi.fn() } as any;
  return { memory: new MemorySystem(db, logger), addMemory };
}

const LEARNING =
  "Compiler verification showed that narrowing the nullable user id before assignment resolves TS2322 in src/auth/session.ts";

describe("automatic memory approval", () => {
  it("keeps inferred learnings pending by default", async () => {
    const { memory, addMemory } = createMemory(undefined);

    await memory.addDurableLearningIfNovel(LEARNING, 7, 42, "pending");

    expect(addMemory).toHaveBeenCalledWith(expect.objectContaining({ status: "pending", conversationId: 42 }));
  });

  it("keeps inferred learnings pending when the setting cannot be read", async () => {
    const addMemory = vi.fn().mockResolvedValue({});
    const db = {
      getMemories: vi.fn().mockResolvedValue([]),
      getSetting: vi.fn().mockRejectedValue(new Error("settings unavailable")),
      addMemory,
    } as any;
    const memory = new MemorySystem(db, { debug: vi.fn() } as any);

    await memory.addDurableLearningIfNovel(LEARNING, 7, 42, "pending");

    expect(addMemory).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
  });

  it.each(["true", "1", "yes", "on"])("promotes pending learning only when explicitly enabled: %s", async (setting) => {
    const { memory, addMemory } = createMemory(setting);

    await memory.addDurableLearningIfNovel(LEARNING, 7, 42, "pending");

    expect(addMemory).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
  });

  it("never downgrades an explicitly approved memory", async () => {
    const { memory, addMemory } = createMemory("false");

    await memory.addLongTermIfNovel("User explicitly prefers concise German answers for this project", 8, 42, "approved");

    expect(addMemory).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
  });
});
