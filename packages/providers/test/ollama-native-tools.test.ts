import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OllamaProvider } from "../src/ollama-provider.ts";
import type { LLMMessage, ToolDefinition } from "@ducki/shared";

/**
 * Regression coverage for a real bug found while auditing the tool-call pipeline:
 * OllamaProvider.generate() (added to fix image handling) built its own request body from
 * scratch and never included `tools`/`tool_choice`, and never read `tool_calls` back out of
 * the response - even though supportsNativeTools() (inherited from OpenAIProvider) reported
 * true. Every non-streaming Ollama call therefore silently fell back to the far more fragile
 * text `[TOOL:...]` protocol, with the agent never finding out a native path existed.
 */
describe("OllamaProvider native tool calls", () => {
  const tools: ToolDefinition[] = [
    { name: "filesystem", description: "fs ops", parameters: { type: "object", properties: {} } },
  ];
  const messages: LLMMessage[] = [{ role: "user", content: "write the file" }];

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends tools/tool_choice in the request body when tools are supplied", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });

    const provider = new OllamaProvider({ model: "llama3", baseUrl: "http://localhost:11434" });
    await provider.generate(messages, { tools, maxTokens: 100 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.tools).toBeDefined();
    expect(body.tools[0].function.name).toBe("filesystem");
    expect(body.tool_choice).toBe("auto");
  });

  it("parses tool_calls back out of the response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "filesystem", arguments: '{"action":"write"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });

    const provider = new OllamaProvider({ model: "llama3", baseUrl: "http://localhost:11434" });
    const result = await provider.generate(messages, { tools, maxTokens: 100 });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.function.name).toBe("filesystem");
    expect(result.toolCalls![0]!.function.arguments).toBe('{"action":"write"}');
  });

  it("does not send tools when none are supplied", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });

    const provider = new OllamaProvider({ model: "llama3", baseUrl: "http://localhost:11434" });
    await provider.generate(messages, { maxTokens: 100 });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.tools).toBeUndefined();
  });

  it("retries without tools once when the backend rejects the tools param", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        clone() { return this; },
        text: async () => "Error: unsupported parameter 'tools'",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

    const provider = new OllamaProvider({ model: "llama3", baseUrl: "http://localhost:11434" });
    const result = await provider.generate(messages, { tools, maxTokens: 100 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondBody.tools).toBeUndefined();
    expect(result.content).toBe("ok");
  });
});
