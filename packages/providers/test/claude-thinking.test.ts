import { describe, expect, it } from "vitest";
import type { LLMMessage } from "@ducki/shared";
import { ClaudeProvider, toAnthropicMessages } from "../src/claude-provider.js";
import { toOpenAIMessages } from "../src/openai-provider.js";
import { withReasoningEffort } from "../src/reasoning.js";

const THINKING = { type: "thinking", thinking: "plan the read", signature: "sig-abc" };
const toolCall = { id: "t1", type: "function" as const, function: { name: "read", arguments: "{\"p\":1}" } };

function historyWithToolTurn(thinkingBlocks?: unknown[]): LLMMessage[] {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "fix it" },
    { role: "assistant", content: "", toolCalls: [toolCall], ...(thinkingBlocks ? { thinkingBlocks } : {}) },
    { role: "tool", toolCallId: "t1", content: "file content" },
  ];
}

function providerCapturingRequests(model = "claude-haiku-4-5", responseContent: unknown[] = [{ type: "text", text: "ok" }]) {
  const provider = new ClaudeProvider({ model, apiKey: "test" } as never);
  const requests: Array<Record<string, unknown>> = [];
  (provider as unknown as { client: unknown }).client = {
    messages: {
      create: async (request: Record<string, unknown>) => {
        requests.push(request);
        return {
          content: responseContent,
          usage: { input_tokens: 1, output_tokens: 1 },
          model,
          stop_reason: "end_turn",
        };
      },
    },
  };
  return { provider, requests };
}

describe("Claude extended thinking with tool use", () => {
  it("echoes thinking blocks first in the assistant turn that carries the tool_use", () => {
    const result = toAnthropicMessages(historyWithToolTurn([THINKING])) as unknown as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const assistant = result.find((m) => m.role === "assistant")!;
    expect(assistant.content[0]).toEqual(THINKING);
    expect(assistant.content[1]).toMatchObject({ type: "tool_use", id: "t1" });
  });

  it("keeps thinking on and drops the caller's temperature when the tool turn has its thinking", async () => {
    const { provider, requests } = providerCapturingRequests();
    await withReasoningEffort("medium", () => provider.generate(historyWithToolTurn([THINKING]), { temperature: 0.3, maxTokens: 16000 }));
    const request = requests[0]!;
    expect(request["thinking"]).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(request["temperature"]).toBeUndefined();
  });

  it("runs the request without thinking when the final tool turn has no thinking block (e.g. reloaded history)", async () => {
    const { provider, requests } = providerCapturingRequests();
    await withReasoningEffort("medium", () => provider.generate(historyWithToolTurn(), { temperature: 0.3 }));
    const request = requests[0]!;
    expect(request["thinking"]).toBeUndefined();
    expect(request["temperature"]).toBe(0.3);
  });

  it("strips echoed thinking blocks from requests that do not use thinking", async () => {
    const { provider, requests } = providerCapturingRequests();
    await provider.generate(historyWithToolTurn([THINKING]));
    const messages = requests[0]!["messages"] as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(messages.flatMap((m) => m.content).some((block) => block.type === "thinking")).toBe(false);
  });

  it("returns the response's thinking blocks verbatim so the caller can echo them", async () => {
    const { provider } = providerCapturingRequests("claude-haiku-4-5", [
      THINKING,
      { type: "tool_use", id: "t2", name: "read", input: {} },
    ]);
    const result = await withReasoningEffort("medium", () => provider.generate([{ role: "user", content: "go" }]));
    expect(result.thinkingBlocks).toEqual([THINKING]);
    expect(result.toolCalls?.[0]?.id).toBe("t2");
  });

  it("assembles streamed thinking and signature deltas into a complete block", async () => {
    const provider = new ClaudeProvider({ model: "claude-haiku-4-5", apiKey: "test" } as never);
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "first " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "second" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t3", name: "read", input: {} } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    ];
    (provider as unknown as { client: unknown }).client = {
      messages: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
          },
          finalMessage: async () => ({
            content: [{ type: "thinking", thinking: "", signature: "" }, { type: "tool_use", id: "t3", name: "read", input: {} }],
          }),
        }),
      },
    };
    const result = await withReasoningEffort("medium", () => provider.generateStream([{ role: "user", content: "go" }]));
    expect(result.thinkingBlocks).toEqual([{ type: "thinking", thinking: "first second", signature: "SIG" }]);
    expect(result.toolCalls?.[0]?.id).toBe("t3");
  });

  it("never sends thinking to Claude 3.x models, which reject the parameter", async () => {
    const { provider, requests } = providerCapturingRequests("claude-3-5-sonnet-20241022");
    await withReasoningEffort("high", () => provider.generate([{ role: "user", content: "go" }], { temperature: 0.2 }));
    expect(requests[0]!["thinking"]).toBeUndefined();
    expect(requests[0]!["temperature"]).toBe(0.2);
  });
});

describe("OpenRouter reasoning_details round-trip", () => {
  const details = [{ type: "reasoning.text", text: "why", signature: "s", index: 0 }];
  const history: LLMMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [toolCall], thinkingBlocks: details },
    { role: "tool", toolCallId: "t1", content: "done" },
  ];

  it("echoes reasoning_details next to tool_calls when enabled", () => {
    const messages = toOpenAIMessages(history, { echoReasoningDetails: true }) as unknown as Array<Record<string, unknown>>;
    expect(messages[1]!["reasoning_details"]).toEqual(details);
  });

  it("leaves plain OpenAI-compatible requests untouched", () => {
    const messages = toOpenAIMessages(history) as unknown as Array<Record<string, unknown>>;
    expect(messages[1]!["reasoning_details"]).toBeUndefined();
  });
});
