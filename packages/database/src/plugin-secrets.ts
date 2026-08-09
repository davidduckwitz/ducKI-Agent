import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Symmetric secret encryption for plugin settings (AES-256-GCM). Plugin secrets (OAuth
 * tokens, bot tokens, API keys) must never be persisted in clear text and must never leave
 * the server through the plugin-listing API. This module owns the at-rest crypto so both the
 * settings store and any future connector code share one, tested implementation.
 *
 * Pure Node: node:crypto only, no new dependency. The key comes from DUCKI_SECRET_KEY (env)
 * or a generated file next to the plugins directory - created once, kept out of the repo.
 */

const ENC_PREFIX = "enc:v1:";

/** Mirror the plugins-root resolution used by plugin-storage (no cross-package import). */
function pluginsRoot(): string {
  return process.env["DUCKI_PLUGINS_DIR"] ?? resolve(process.cwd(), "plugins");
}

let cachedKey: Buffer | undefined;

/** Read a 32-byte key from env, else read/create a persistent key file. */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env["DUCKI_SECRET_KEY"]?.trim();
  if (fromEnv) {
    const buf = /^[0-9a-fA-F]{64}$/.test(fromEnv)
      ? Buffer.from(fromEnv, "hex")
      : Buffer.from(fromEnv, "base64");
    if (buf.length !== 32) {
      throw new Error("DUCKI_SECRET_KEY must decode to 32 bytes (hex or base64)");
    }
    cachedKey = buf;
    return buf;
  }

  const root = pluginsRoot();
  const keyFile = resolve(root, ".secret-key");
  if (existsSync(keyFile)) {
    const raw = readFileSync(keyFile, "utf8").trim();
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) {
      cachedKey = buf;
      return buf;
    }
  }

  const generated = randomBytes(32);
  mkdirSync(root, { recursive: true });
  writeFileSync(keyFile, generated.toString("base64"), { encoding: "utf8", mode: 0o600 });
  cachedKey = generated;
  return generated;
}

/** True when a stored value is one produced by encryptSecret (so decrypt is safe to skip). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

/** Encrypt a UTF-8 string. Output: `enc:v1:<iv>:<tag>:<cipher>` (each part base64). */
export function encryptSecret(plain: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

/** Decrypt a value produced by encryptSecret. Non-encrypted input is returned unchanged. */
export function decryptSecret(blob: string): string {
  if (!isEncrypted(blob)) return blob;
  const [, , ivB64, tagB64, dataB64] = blob.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted secret");
  }
  const key = getKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}
