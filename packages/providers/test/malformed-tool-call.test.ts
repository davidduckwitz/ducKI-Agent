import { describe, expect, it, vi } from "vitest";
import { LMStudioProvider } from "../src/lmstudio-provider.ts";

const messages = [{ role: "user" as const, content: "Hello" }];
const parseError = Object.assign(
  new Error('500 llama-server error: Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] missing closing quote'),
  { status: 500 }
);

function setup(create: (...args: any[]) => Promise<any>) {
  const provider = new LMStudioProvider({ model: "local-model", baseUrl: "http://localhost/v1" });
  (provider as any).client = { chat: { completions: { create: vi.fn(create) } } };
  return provider;
}

describe("cut-off native tool call (llama.cpp 500 parse error)", () => {
  it("is reported as an empty length-truncated turn once the native-tools fallback is spent", async () => {
    const provider = setup(async () => { throw parseError; });
    (provider as any).nativeToolsUnsupported = true;
    const result = await provider.generate(messages);
    expect(result.finishReason).toBe("length");
    expect(result.content).toBe("");
    expect(result.toolCalls ?? []).toHaveLength(0);
  });

  it("still propagates unrelated server errors", async () => {
    const provider = setup(async () => { throw Object.assign(new Error("500 boom"), { status: 500 }); });
    await expect(provider.generate(messages)).rejects.toThrow("boom");
  });
});
