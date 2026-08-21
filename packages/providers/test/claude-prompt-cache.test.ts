import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { LLMMessage } from "@ducki/shared";

/** Captures the request body the provider hands to the SDK, without any network call. */
const createMock = vi.fn();
const streamMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createMock, stream: streamMock };
    constructor(_options: unknown) {}
  }
  return { default: FakeAnthropic };
});

const { ClaudeProvider } = await import("../src/claude-provider.ts");

function emptyResponse() {
  return {
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    model: "claude-sonnet-5",
    stop_reason: "end_turn",
  };
}

describe("ClaudeProvider prompt caching", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue(emptyResponse());
  });

  afterEach(() => {
    delete process.env["DUCKI_NATIVE_TOOLS"];
  });

  const provider = () => new ClaudeProvider({ baseUrl: "", apiKey: "k", model: "claude-sonnet-5" });

  it("puts a cache breakpoint on a system message marked cacheable", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "STATIC DIRECTIVE", cacheControl: "ephemeral" },
      { role: "user", content: "do the thing" },
    ];

    await provider().generate(messages);

    const body = createMock.mock.calls[0]![0] as { system: Array<Record<string, unknown>> };
    expect(body.system).toEqual([
      { type: "text", text: "STATIC DIRECTIVE", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("leaves an unmarked system message uncached", async () => {
    await provider().generate([
      { role: "system", content: "volatile" },
      { role: "user", content: "hi" },
    ]);

    const body = createMock.mock.calls[0]![0] as { system: Array<Record<string, unknown>> };
    expect(body.system[0]).not.toHaveProperty("cache_control");
  });

  it("reports cache reads separately but still counts them as input", async () => {
    const result = await provider().generate([{ role: "user", content: "hi" }]);
    expect(result.usage.cachedInputTokens).toBe(900);
    // 10 fresh + 900 cached: a well-cached run must not look like it consumed almost nothing.
    expect(result.usage.promptTokens).toBe(910);
  });

  it("merges consecutive same-role messages and drops a leading assistant turn", async () => {
    await provider().generate([
      { role: "system", content: "sys" },
      { role: "assistant", content: "orphaned opener" },
      { role: "user", content: "first" },
      { role: "tool", content: "tool result" },
      { role: "user", content: "second" },
      { role: "assistant", content: "reply" },
    ]);

    const body = createMock.mock.calls[0]![0] as { messages: Array<{ role: string; content: unknown[] }> };
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // first + tool result + second all collapse into one user turn with three blocks.
    expect(body.messages[0]!.content).toHaveLength(3);
  });

  it("caches the tool block by marking the last tool definition", async () => {
    await provider().generate(
      [{ role: "user", content: "hi" }],
      {
        tools: [
          { name: "a", description: "a", parameters: { type: "object", properties: {} } },
          { name: "b", description: "b", parameters: { type: "object", properties: {} } },
        ],
      }
    );

    const body = createMock.mock.calls[0]![0] as { tools: Array<Record<string, unknown>> };
    expect(body.tools[0]).not.toHaveProperty("cache_control");
    expect(body.tools[1]!["cache_control"]).toEqual({ type: "ephemeral" });
  });

  it("omits tools entirely when native tool calling is switched off", async () => {
    process.env["DUCKI_NATIVE_TOOLS"] = "0";
    await provider().generate(
      [{ role: "user", content: "hi" }],
      { tools: [{ name: "a", description: "a", parameters: { type: "object", properties: {} } }] }
    );
    const body = createMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(body["tools"]).toBeUndefined();
  });
});

// The live path for provider name "claude" is AnthropicAdapter, not ClaudeProvider
// (see createProvider), so the cache breakpoint has to be verified there too - caching only
// the class that nothing constructs would be worth exactly nothing.
const { AnthropicAdapter } = await import("../src/adapters/anthropic-adapter.ts");

describe("AnthropicAdapter prompt caching", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 },
    });
  });

  const adapter = () =>
    new AnthropicAdapter({ baseUrl: "https://api.anthropic.com/v1", apiKey: "k", model: "claude-sonnet-5" });

  it("marks a cacheable system message with a breakpoint", async () => {
    await adapter().generate([
      { role: "system", content: "STATIC DIRECTIVE", cacheControl: "ephemeral" },
      { role: "user", content: "go" },
    ]);

    const body = createMock.mock.calls[0]![0] as { system: Array<Record<string, unknown>> };
    expect(body.system).toEqual([
      { type: "text", text: "STATIC DIRECTIVE", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("counts cached input tokens as input", async () => {
    const result = await adapter().generate([{ role: "user", content: "go" }]);
    expect(result.usage.cachedInputTokens).toBe(1500);
    expect(result.usage.promptTokens).toBe(1512);
  });

  it("merges same-role turns so the API's alternation rule is satisfied", async () => {
    await adapter().generate([
      { role: "system", content: "sys" },
      { role: "assistant", content: "orphan" },
      { role: "user", content: "a" },
      { role: "tool", content: "result" },
      { role: "assistant", content: "b" },
    ]);

    const body = createMock.mock.calls[0]![0] as { messages: Array<{ role: string }> };
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

// The OpenAI-compatible path is shared by OpenRouter, LM Studio, Ollama and llama.cpp. Only
// the gateway that understands a cache breakpoint may be sent one - a local runtime that only
// accepts a plain string for the system role would otherwise reject or silently drop it.
const { toOpenAIMessages } = await import("../src/openai-provider.ts");

describe("toOpenAIMessages cache breakpoints", () => {
  const messages: LLMMessage[] = [
    { role: "system", content: "STATIC DIRECTIVE", cacheControl: "ephemeral" },
    { role: "user", content: "go" },
  ];

  it("keeps the system message a plain string by default", () => {
    const out = toOpenAIMessages(messages);
    expect(out[0]).toEqual({ role: "system", content: "STATIC DIRECTIVE" });
  });

  it("emits content parts with cache_control when the backend supports it", () => {
    const out = toOpenAIMessages(messages, { emitCacheControl: true });
    expect(out[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "STATIC DIRECTIVE", cache_control: { type: "ephemeral" } }],
    });
  });

  it("leaves an unmarked system message alone even for a cache-capable backend", () => {
    const out = toOpenAIMessages([{ role: "system", content: "volatile" }], { emitCacheControl: true });
    expect(out[0]).toEqual({ role: "system", content: "volatile" });
  });
});

/**
 * A stream that dies mid-flight must not throw away what it already delivered.
 *
 * Discarding it sent the caller into a full synchronous re-run - the very mode that struggles
 * with a large max_tokens - so a hiccup while writing a big file produced no file at all. The
 * partial response now comes back flagged incomplete: usable for reading, refused for writing.
 */
const { isIncompleteResponse, INCOMPLETE_STREAM_FINISH_REASON } = await import("@ducki/shared");

describe("incomplete response classification", () => {
  it("treats both the output cap and a broken stream as incomplete", () => {
    expect(isIncompleteResponse("length")).toBe(true);
    expect(isIncompleteResponse(INCOMPLETE_STREAM_FINISH_REASON)).toBe(true);
  });

  it("treats a normal finish as complete", () => {
    for (const reason of ["stop", "end_turn", "tool_use", "tool_calls", undefined]) {
      expect(isIncompleteResponse(reason), String(reason)).toBe(false);
    }
  });
});
