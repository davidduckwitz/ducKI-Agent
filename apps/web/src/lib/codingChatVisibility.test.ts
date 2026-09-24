import { describe, expect, it } from "vitest";
import type { RenderedChatMessage } from "../components/chat/chatTypes";
import { isInternalCodingUserMessage, isVisibleCodingChatMessage } from "./codingChatVisibility";

function message(
  role: RenderedChatMessage["role"],
  metadata?: Record<string, unknown>
): RenderedChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content: "test",
    timestamp: "2026-09-24T00:00:00.000Z",
    metadata,
  };
}

describe("coding chat visibility", () => {
  it("keeps prompts actually entered by the user visible", () => {
    expect(isVisibleCodingChatMessage(message("user"))).toBe(true);
    expect(isVisibleCodingChatMessage(message("user", { localMessageId: "prompt-1" }))).toBe(true);
  });

  it("hides explicitly internal model-steering prompts", () => {
    const internal = message("user", { internal: true, runtimeContext: true, kind: "tool_analysis" });
    expect(isInternalCodingUserMessage(internal)).toBe(true);
    expect(isVisibleCodingChatMessage(internal)).toBe(false);
  });

  it("hides legacy rows whose internal flag was overwritten by runtimeContext", () => {
    const legacy = message("user", { runtimeContext: true });
    expect(isInternalCodingUserMessage(legacy)).toBe(true);
    expect(isVisibleCodingChatMessage(legacy)).toBe(false);
  });

  it("shows assistant output but not system, tool, or activity rows", () => {
    expect(isVisibleCodingChatMessage(message("assistant"))).toBe(true);
    expect(isVisibleCodingChatMessage(message("system"))).toBe(false);
    expect(isVisibleCodingChatMessage(message("tool"))).toBe(false);
    expect(isVisibleCodingChatMessage(message("event"))).toBe(false);
  });
});
