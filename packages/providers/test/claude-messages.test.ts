import { describe, expect, it } from "vitest";
import { toAnthropicMessages } from "../src/claude-provider.js";

describe("toAnthropicMessages", () => {
  it("pairs echoed tool results, degrades orphans to text, keeps images and caches the tail", () => {
    const result = toAnthropicMessages([
      { role: "system", content: "sys" },
      { role: "assistant", content: "leading assistant is dropped" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{\"p\":1}" } }] },
      { role: "tool", toolCallId: "batch_1", content: "orphan" },
      { role: "tool", toolCallId: "t1", content: "ok" },
      { role: "user", content: [{ type: "text", text: "shot" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ]) as unknown as Array<{ role: string; content: Array<Record<string, unknown>> }>;

    expect(result.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(result[1]!.content).toEqual([{ type: "tool_use", id: "t1", name: "read", input: { p: 1 } }]);

    const last = result[2]!.content;
    expect(last[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "ok" });
    expect(last).toContainEqual({ type: "text", text: "[Tool result]\norphan" });
    expect(last[last.length - 1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
      cache_control: { type: "ephemeral" },
    });
  });

  it("degrades a tool_use to text when its result does not follow immediately", () => {
    const result = toAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "batch_5_0", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "user", content: "interjection" },
      { role: "assistant", content: "ok" },
      { role: "tool", toolCallId: "batch_5_0", content: "late" },
    ]) as unknown as Array<{ role: string; content: Array<Record<string, unknown>> }>;

    const blocks = result.flatMap((m) => m.content);
    expect(blocks.some((b) => b["type"] === "tool_use" || b["type"] === "tool_result")).toBe(false);
    expect(blocks).toContainEqual({ type: "text", text: "[Tool call] read {}" });
    expect(blocks.some((b) => b["text"] === "[Tool result]\nlate")).toBe(true);
  });

  it("never emits bare strings or empty text blocks", () => {
    const result = toAnthropicMessages([
      { role: "user", content: "a" },
      { role: "tool", content: "b" },
      { role: "user", content: "" },
    ]) as unknown as Array<{ content: unknown[] }>;

    expect(result).toHaveLength(1);
    for (const block of result[0]!.content) expect(typeof block).toBe("object");
  });
});
