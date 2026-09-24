import { describe, expect, it, vi } from "vitest";
import { isReasoningEffort, REASONING_EFFORTS } from "../../shared/src/index.ts";
import { withReasoningEffort, resolveReasoningEffort, claudeReasoningOptions } from "../src/reasoning.ts";
import { OpenAIProvider } from "../src/openai-provider.ts";
import { OllamaProvider } from "../src/ollama-provider.ts";
import { OpenRouterProvider } from "../src/openrouter-provider.ts";

const messages = [{ role: "user" as const, content: "Hello" }];
const completion = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

describe("reasoning controls", () => {
  it("validates the public values without treating invalid input as off", () => {
    for (const effort of REASONING_EFFORTS) expect(isReasoningEffort(effort)).toBe(true);
    for (const value of [null, undefined, "none", "HIGH", 1, {}, ""]) expect(isReasoningEffort(value)).toBe(false);
  });

  it("isolates overlapping runs and inherits the choice in nested agent phases", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withReasoningEffort("high", async () => {
      await gate;
      return withReasoningEffort(undefined, () => resolveReasoningEffort({ reasoningEffort: "low" }));
    });
    const second = withReasoningEffort("off", async () => {
      await Promise.resolve();
      expect(resolveReasoningEffort({})).toBe("off");
      release();
    });
    await second;
    expect(await first).toBe("high");
    expect(resolveReasoningEffort({})).toBeUndefined();
    await expect(withReasoningEffort("xhigh", async () => { throw new Error("cancelled"); })).rejects.toThrow("cancelled");
    expect(resolveReasoningEffort({})).toBeUndefined();
  });

  it.each(REASONING_EFFORTS)("sends %s on both OpenAI request paths", async (effort) => {
    const provider = new OpenAIProvider({ baseUrl: "http://localhost/v1", model: "gpt-5.2", apiKey: "test" });
    const create = vi.fn(async (body) => body.stream ? (async function* () {
      yield { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: completion.usage };
    })() : completion);
    (provider as any).client = { chat: { completions: { create } } };
    await withReasoningEffort(effort, async () => {
      await provider.generate(messages, { temperature: 0.5, maxTokens: 2000 });
      await provider.generateStream(messages, { temperature: 0.5, maxTokens: 2000 });
    });
    for (const [body] of create.mock.calls) {
      expect(body.reasoning_effort).toBe(effort === "off" ? "none" : effort);
      expect(body.max_completion_tokens).toBe(2000);
      expect(body.max_tokens).toBeUndefined();
      expect(body.temperature).toBeUndefined();
    }
    await provider.generate(messages);
    expect(create.mock.calls.at(-1)![0]).not.toHaveProperty("reasoning_effort");
  });

  it("uses OpenRouter's reasoning object", async () => {
    const provider = new OpenRouterProvider({ model: "anthropic/claude-sonnet-4.6", apiKey: "test" });
    const create = vi.fn(async () => completion);
    (provider as any).client = { chat: { completions: { create } } };
    await provider.generate(messages, { reasoningEffort: "off" });
    expect((create.mock.calls[0] as any)[0].reasoning).toEqual({ enabled: false });
  });

  it("keeps reasoning on Ollama's separate image request path", async () => {
    const provider = new OllamaProvider({ model: "qwen3", baseUrl: "http://localhost:11434" });
    const fetch = vi.fn(async () => new Response(JSON.stringify(completion), { status: 200 }));
    (provider as any).customFetch = fetch;
    await provider.generate(messages, { reasoningEffort: "off" });
    expect(JSON.parse((fetch.mock.calls[0] as any)[1].body).reasoning_effort).toBe("none");
    fetch.mockImplementation(async () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 }));
    await provider.generateStream([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }] }], { reasoningEffort: "xhigh" });
    expect(JSON.parse((fetch.mock.calls[1] as any)[1].body).reasoning_effort).toBe("xhigh");
  });

  it("maps Claude budgets without leaving no room for the answer", () => {
    expect(claudeReasoningOptions("claude-sonnet-4-5", {})).toEqual({});
    expect(claudeReasoningOptions("claude-sonnet-4-5", { reasoningEffort: "off" })).toEqual({ thinking: { type: "disabled" } });
    expect(claudeReasoningOptions("claude-sonnet-4-5", { reasoningEffort: "xhigh", maxTokens: 2000 })).toMatchObject({ thinking: { type: "enabled", budget_tokens: 16384 }, max_tokens: 17408 });
    expect(claudeReasoningOptions("claude-opus-4-6", { reasoningEffort: "xhigh" })).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "max" } });
    expect(claudeReasoningOptions("claude-opus-4-7", { reasoningEffort: "xhigh" })).toMatchObject({ output_config: { effort: "xhigh" } });
  });
});
