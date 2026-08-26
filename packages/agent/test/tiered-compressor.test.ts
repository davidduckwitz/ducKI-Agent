import { describe, expect, it, vi, beforeEach } from "vitest";
import type { LLMMessage } from "@ducki/shared";
import {
  TieredContextCompressor,
  type CompressionTier,
} from "../src/context/tiered-compressor.js";

// ── Mock LLMProvider ────────────────────────────────────────────────────────

function makeMockProvider(summaryText = "Compressed summary of the conversation.") {
  return {
    generate: vi.fn(async () => ({
      content: summaryText,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    })),
    model: "claude-sonnet-5", // Use a real model with a known large context window
  } as any;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMessages(count: number, role: LLMMessage["role"] = "user", contentLength = 100): LLMMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role,
    content: `${role} message ${i}: ${"x".repeat(contentLength)}`,
  }));
}

function makeMixedMessages(count: number): LLMMessage[] {
  const messages: LLMMessage[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 3 === 0) messages.push({ role: "user", content: `User message ${i}: ${"x".repeat(100)}` });
    else if (i % 3 === 1) messages.push({ role: "assistant", content: `Assistant message ${i}: ${"x".repeat(100)}` });
    else messages.push({ role: "user", content: `[tools] Tool result ${i}: ${"x".repeat(200)}` });
  }
  return messages;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("TieredContextCompressor", () => {
  let provider: ReturnType<typeof makeMockProvider>;

  beforeEach(() => {
    provider = makeMockProvider();
  });

  describe("getCompressionTier", () => {
    it("returns tier 0 for very few messages", () => {
      const compressor = new TieredContextCompressor(provider, { modelName: "claude-sonnet-5" });
      const messages = makeMessages(5);
      expect(compressor.getCompressionTier(messages)).toBe(0);
    });

    it("returns higher tiers for more messages with low thresholds", () => {
      // With very low thresholds (0.001%), even a few messages should trigger tier 1+
      const compressorLow = new TieredContextCompressor(provider, {
        modelName: "claude-sonnet-5",
        thresholds: [0.001, 0.002, 0.003],
      });
      const messages = makeMessages(10, "user", 500);
      expect(compressorLow.getCompressionTier(messages)).toBeGreaterThan(0);
    });
  });

  describe("getUsagePercent", () => {
    it("returns a percentage", () => {
      const compressor = new TieredContextCompressor(provider, { modelName: "claude-sonnet-5" });
      const messages = makeMessages(10);
      const percent = compressor.getUsagePercent(messages);
      // For a 1M context model, 10 short messages should use < 1%
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThan(5);
    });
  });

  describe("compress", () => {
    it("returns unchanged messages for tier 0", async () => {
      const compressor = new TieredContextCompressor(provider, { modelName: "claude-sonnet-5" });
      const messages = makeMessages(3);
      const result = await compressor.compress(messages);

      expect(result.decision.tier).toBe(0);
      expect(result.messages).toHaveLength(3);
      expect(result.decision.tokensSaved).toBe(0);
      expect(provider.generate).not.toHaveBeenCalled();
    });

    it("applies tier 1 light prune", async () => {
      const compressor = new TieredContextCompressor(provider, {
        modelName: "claude-sonnet-5",
        thresholds: [0.001, 0.5, 0.9],
      });
      const messages = makeMixedMessages(20);
      const result = await compressor.compress(messages);

      expect(result.decision.tier).toBe(1);
      expect(result.messages.length).toBeLessThanOrEqual(messages.length);
      expect(result.decision.reason).toContain("Tier 1");
      // Tier 1 doesn't call the LLM
      expect(provider.generate).not.toHaveBeenCalled();
    });

    it("applies tier 2 aggressive compress with LLM call", async () => {
      const compressor = new TieredContextCompressor(provider, {
        modelName: "claude-sonnet-5",
        thresholds: [0.001, 0.002, 0.9],
      });
      const messages = makeMixedMessages(30);
      const result = await compressor.compress(messages);

      expect(result.decision.tier).toBe(2);
      expect(result.messages.length).toBeLessThanOrEqual(messages.length);
      expect(result.decision.reason).toContain("Tier 2");
      expect(provider.generate).toHaveBeenCalled();
    });

    it("applies tier 3 emergency drop", async () => {
      const compressor = new TieredContextCompressor(provider, {
        modelName: "claude-sonnet-5",
        thresholds: [0.001, 0.002, 0.003],
      });
      const messages = makeMixedMessages(50);
      const result = await compressor.compress(messages);

      expect(result.decision.tier).toBe(3);
      expect(result.decision.reason).toContain("Tier 3");
      expect(result.decision.reason).toContain("Emergency drop");
      // Should keep only emergencyKeepCount messages
      expect(result.messages.length).toBeLessThanOrEqual(15); // system + 10 keep
    });

    it("preserves system messages across all tiers", async () => {
      const compressor = new TieredContextCompressor(provider, {
        modelName: "claude-sonnet-5",
        thresholds: [0.001, 0.002, 0.003],
      });
      const systemMsg: LLMMessage = { role: "system", content: "You are a helpful assistant." };
      const messages = [systemMsg, ...makeMixedMessages(50)];
      const result = await compressor.compress(messages);

      const systemMessages = result.messages.filter((m) => m.role === "system");
      expect(systemMessages.length).toBeGreaterThanOrEqual(1);
      expect(systemMessages[0].content).toBe("You are a helpful assistant.");
    });
  });

  describe("config", () => {
    it("respects custom thresholds", () => {
      const compressor = new TieredContextCompressor(provider, {
        modelName: "claude-sonnet-5",
        thresholds: [10, 20, 30],
      });
      // With very high thresholds, should stay at tier 0
      const messages = makeMessages(5);
      expect(compressor.getCompressionTier(messages)).toBe(0);
    });

    it("respects custom emergencyKeepCount", async () => {
      const compressor = new TieredContextCompressor(provider, {
        modelName: "claude-sonnet-5",
        thresholds: [0.001, 0.002, 0.003],
        emergencyKeepCount: 5,
      });
      const messages = makeMixedMessages(50);
      const result = await compressor.compress(messages);

      expect(result.decision.tier).toBe(3);
      // Should keep only 5 non-system messages + system messages
      const nonSystem = result.messages.filter((m) => m.role !== "system");
      expect(nonSystem.length).toBeLessThanOrEqual(5);
    });
  });

  describe("summaryChunk", () => {
    it("handles LLM failure gracefully", async () => {
      provider.generate.mockRejectedValue(new Error("LLM unavailable"));
      const compressor = new TieredContextCompressor(provider, {
        modelName: "claude-sonnet-5",
        thresholds: [0.001, 0.002, 0.9],
      });
      const messages = makeMixedMessages(30);
      const result = await compressor.compress(messages);

      // Should still compress, just with fallback summaries
      expect(result.decision.tier).toBe(2);
      expect(result.messages.length).toBeLessThanOrEqual(messages.length);
    });
  });
});
