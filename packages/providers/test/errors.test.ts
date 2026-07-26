import {
  ProviderConnectionError,
  isProviderConnectionError,
  looksLikeConnectionFailure,
} from "../src/errors";
import { estimateUsage } from "../src/token-estimate";

describe("looksLikeConnectionFailure", () => {
  test("recognizes the OpenAI SDK's APIConnectionError", () => {
    const error = Object.assign(new Error("Connection error."), { name: "APIConnectionError" });
    expect(looksLikeConnectionFailure(error)).toBe(true);
  });

  test("recognizes a refused socket via the cause chain", () => {
    const error = new Error("fetch failed");
    (error as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
    expect(looksLikeConnectionFailure(error)).toBe(true);
  });

  test("recognizes a nested cause", () => {
    const error = new Error("request failed");
    (error as { cause?: unknown }).cause = { cause: { code: "ENOTFOUND" } };
    expect(looksLikeConnectionFailure(error)).toBe(true);
  });

  test("does not treat an HTTP error as a connection failure", () => {
    // A 429/400 means a server answered - retrying or falling back can still make sense.
    const error = Object.assign(new Error("Connection error."), { status: 429 });
    expect(looksLikeConnectionFailure(error)).toBe(false);
  });

  test("ignores unrelated errors", () => {
    expect(looksLikeConnectionFailure(new Error("context length exceeded"))).toBe(false);
    expect(looksLikeConnectionFailure(undefined)).toBe(false);
  });
});

describe("ProviderConnectionError", () => {
  test("names provider, endpoint and socket code", () => {
    const error = new ProviderConnectionError("lmstudio", "http://localhost:1234/v1", {
      code: "ECONNREFUSED",
    });
    expect(error.message).toContain("lmstudio");
    expect(error.message).toContain("http://localhost:1234/v1");
    expect(error.message).toContain("ECONNREFUSED");
    expect(isProviderConnectionError(error)).toBe(true);
  });

  test("is not confused with an ordinary error", () => {
    expect(isProviderConnectionError(new Error("Connection error."))).toBe(false);
  });

  test("does not match the agent's provider-load heuristics", () => {
    // agent.ts routes on substrings like "context"/"token"; a connection error must not
    // accidentally trigger the compact-prompt retry chain.
    const message = new ProviderConnectionError("lmstudio", "http://localhost:1234/v1").message.toLowerCase();
    for (const marker of ["402", "provider returned error", "payment", "quota", "context", "too large", "token"]) {
      expect(message).not.toContain(marker);
    }
  });
});

describe("estimateUsage", () => {
  test("produces non-zero counts when the server reports none", () => {
    const usage = estimateUsage([{ role: "user", content: "Erklaere mir den Plan-Modus" }], "Der Plan-Modus erstellt nur einen Plan.");
    expect(usage.promptTokens).toBeGreaterThan(0);
    expect(usage.completionTokens).toBeGreaterThan(0);
    expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
  });

  test("scales with input size", () => {
    const short = estimateUsage([{ role: "user", content: "hi" }], "ok");
    const long = estimateUsage([{ role: "user", content: "x".repeat(4000) }], "ok");
    expect(long.promptTokens).toBeGreaterThan(short.promptTokens * 10);
  });

  test("lands in the right magnitude for plain text", () => {
    // 360 characters is roughly 100 tokens; allow a generous band around that.
    const usage = estimateUsage([], "a".repeat(360));
    expect(usage.completionTokens).toBeGreaterThan(60);
    expect(usage.completionTokens).toBeLessThan(160);
  });

  test("ignores image parts, whose data URI length says nothing about token cost", () => {
    const withImage = estimateUsage(
      [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(50000)}` } }] }],
      ""
    );
    expect(withImage.promptTokens).toBeLessThan(50);
  });
});
