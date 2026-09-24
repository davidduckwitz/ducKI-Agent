import { describe, expect, it, vi } from "vitest";
import { LMStudioProvider } from "../src/lmstudio-provider.ts";

const messages = [{ role: "user" as const, content: "Hello" }];
function setup() {
  const provider = new LMStudioProvider({ model: "local-model", baseUrl: "http://localhost/v1" });
  const response = {
    model: "local-model", status: "completed", error: null,
    output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  const create = vi.fn(async (_body: any, _options?: any): Promise<any> => response);
  const chat = vi.fn(async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  (provider as any).client = { responses: { create }, chat: { completions: { create: chat } } };
  return { provider, create, chat, response };
}

describe("LM Studio reasoning transport", () => {
  it("keeps the old endpoint for Standard and uses Responses for explicit effort", async () => {
    const { provider, create, chat } = setup();
    await provider.generate(messages);
    expect(chat).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    const result = await provider.generate(messages, { reasoningEffort: "high" });
    expect(create.mock.calls[0]![0]).toMatchObject({ reasoning: { effort: "high" }, store: false });
    expect(result.content).toBe("ok");
    expect(result.usage.totalTokens).toBe(15);
  });

  it("preserves tool calls, tool results, orphan results and attached images", async () => {
    const { provider, create, response } = setup();
    create.mockResolvedValue({ ...response, output: [{ type: "function_call", call_id: "next", name: "filesystem", arguments: "{}" }] });
    const result = await provider.generate([
      { role: "assistant", content: "", toolCalls: [{ id: "call", type: "function", function: { name: "filesystem", arguments: "{}" } }] },
      { role: "tool", toolCallId: "call", content: "found" },
      { role: "tool", content: "orphan result" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }] },
    ], { reasoningEffort: "off", tools: [{ name: "filesystem", description: "files", parameters: { type: "object" } }] });
    const body = create.mock.calls[0]![0];
    expect(body.reasoning.effort).toBe("none");
    expect(body.input).toEqual([
      { type: "function_call", call_id: "call", name: "filesystem", arguments: "{}" },
      { type: "function_call_output", call_id: "call", output: "found" },
      { role: "user", content: "orphan result" },
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,YQ==" }] },
    ]);
    expect(body.tools[0]).toMatchObject({ type: "function", name: "filesystem" });
    expect(result.toolCalls?.[0]?.id).toBe("next");
  });

  it("streams text, forwards cancellation and retains final tool calls", async () => {
    const { provider, create, response } = setup();
    create.mockResolvedValue((async function* () {
      yield { type: "response.output_text.delta", delta: "ok" };
      yield { type: "response.completed", response };
    })());
    const onChunk = vi.fn();
    const signal = new AbortController().signal;
    const result = await provider.generateStream(messages, { reasoningEffort: "xhigh", signal }, onChunk);
    expect(create.mock.calls[0]).toMatchObject([{ stream: true, reasoning: { effort: "xhigh" } }, { signal }]);
    expect(onChunk).toHaveBeenCalledWith("ok");
    expect(result.finishReason).toBe("stop");
  });

  it("marks a truncated stream incomplete and propagates intentional cancellation", async () => {
    const { provider, create } = setup();
    create.mockResolvedValue((async function* () {
      yield { type: "response.output_text.delta", delta: "partial" };
      throw new Error("connection lost");
    })());
    expect((await provider.generateStream(messages, { reasoningEffort: "low" })).finishReason).toBe("incomplete_stream");
    create.mockResolvedValue((async function* () {
      yield { type: "response.output_text.delta", delta: "partial" };
      throw new DOMException("Stopped", "AbortError");
    })());
    await expect(provider.generateStream(messages, { reasoningEffort: "low" })).rejects.toThrow("Stopped");
  });
});
