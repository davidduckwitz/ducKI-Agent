import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptSecret, decryptSecret, isEncrypted } from "../src/plugin-secrets.js";

// Isolate the generated .secret-key into a temp plugins dir.
beforeAll(() => {
  process.env.DUCKI_PLUGINS_DIR = mkdtempSync(join(tmpdir(), "ducki-secrets-"));
  delete process.env.DUCKI_SECRET_KEY;
});

describe("plugin secret encryption", () => {
  it("round-trips a value through AES-256-GCM", () => {
    const plain = "ya29.super-secret-oauth-token";
    const blob = encryptSecret(plain);
    expect(isEncrypted(blob)).toBe(true);
    expect(blob).not.toContain(plain);
    expect(decryptSecret(blob)).toBe(plain);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("passes through non-encrypted input unchanged", () => {
    expect(decryptSecret("plain-text")).toBe("plain-text");
    expect(isEncrypted("plain-text")).toBe(false);
  });
});
