import { describe, it, expect } from "vitest";
// Explicit .ts extension: a stale committed openai-provider.d.ts in src/ otherwise
// shadows the real module during test resolution (it carries no runtime exports).
import { toOpenAIMessages } from "../src/openai-provider.ts";
import type { LLMMessage } from "@ducki/shared";

describe("toOpenAIMessages tool-result routing", () => {
  it("delivers a tool result as a USER message when no assistant echoed its id", () => {
    // Reproduces the hallucination bug: the agent stamps every tool result with an
    // internal id (batch_1_0) but never persists assistant.tool_calls. An orphaned
    // role:"tool" message gets dropped by the backend -> model never sees the result.
    const messages: LLMMessage[] = [
      { role: "user", content: "welcher tag ist heute?" },
      { role: "assistant", content: "" },
      { role: "tool", content: "Tool Result: Mon Aug 09 2026", toolCallId: "batch_1_0" },
    ];

    const out = toOpenAIMessages(messages);

    const toolMsg = out[2];
    expect(toolMsg.role).toBe("user");
    expect(String(toolMsg.content)).toContain("Tool Result: Mon Aug 09 2026");
  });

  it("emits role:tool only when a preceding assistant echoes the same tool_call id", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_abc", type: "function", function: { name: "shell", arguments: "{}" } }],
      },
      { role: "tool", content: "ok", toolCallId: "call_abc" },
    ];

    const out = toOpenAIMessages(messages);

    expect(out[1].role).toBe("assistant");
    expect((out[1] as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1);
    expect(out[2].role).toBe("tool");
    expect((out[2] as { tool_call_id?: string }).tool_call_id).toBe("call_abc");
  });
});
