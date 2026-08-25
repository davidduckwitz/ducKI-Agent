import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@ducki/logger";
import type { LLMProvider } from "@ducki/providers";
import type { LLMContent, LLMResponse } from "@ducki/shared";
import { createVisionTools } from "../src/vision/vision-tools.ts";

const logger = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
} as unknown as Logger;

function provider(generate: LLMProvider["generate"]): LLMProvider {
  return {
    name: "vision-test",
    model: "vision-test",
    generate,
    generateStream: async () => ({ content: "" }) as LLMResponse,
    supportsStreaming: () => false,
    isAvailable: async () => true,
  };
}

describe("analyze_ui_layout image normalization", () => {
  it("uses the current browser frame when imageUrl is actually a page URL", async () => {
    const generate = vi.fn(async () => ({ content: "layout ok" } as LLMResponse));
    const fallback: LLMContent = {
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,/9j/AAAA", detail: "high" },
    };
    const [tool] = createVisionTools(() => provider(generate), logger, () => true, () => fallback);

    const result = await tool!.execute({ imageUrl: "http://localhost:5173/dashboard" });

    expect(result.success).toBe(true);
    const messages = generate.mock.calls[0]![0];
    expect((messages[0]!.content as LLMContent[])[0]).toEqual(fallback);
  });

  it("normalizes raw base64 accidentally supplied as imageUrl", async () => {
    const generate = vi.fn(async () => ({ content: "visible" } as LLMResponse));
    const [tool] = createVisionTools(() => provider(generate), logger);
    const raw = "A".repeat(132);

    await tool!.execute({ imageUrl: raw, mimeType: "image/jpeg" });

    const messages = generate.mock.calls[0]![0];
    const image = (messages[0]!.content as LLMContent[])[0];
    expect(image).toEqual({
      type: "image_data",
      image_data: { url: `data:image/jpeg;base64,${raw}`, mime_type: "image/jpeg" },
    });
  });

  it("does not claim that an ordinary provider URL error means vision is missing", async () => {
    const generate = vi.fn(async () => { throw new Error('400 "Invalid url."'); });
    const [tool] = createVisionTools(() => provider(generate), logger);

    const result = await tool!.execute({ imageUrl: "https://example.com/image.png" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Vision analysis request failed");
    expect(result.error).not.toContain("vision-capable model loaded");
  });
});
