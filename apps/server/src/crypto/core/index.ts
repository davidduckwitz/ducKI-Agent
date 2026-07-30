export * from "./math";

// Placeholder exports for other core modules
export function encrypt(data: string, key: Buffer): string {
  return Buffer.from(data).toString("hex");
}

export function decrypt(encrypted: string, key: Buffer): string {
  return Buffer.from(encrypted, "hex").toString();
}

export function deriveKey(password: string, salt: Buffer): Buffer {
  return Buffer.from(password);
}

export function generateRandomKey(): Buffer {
  const { randomBytes } = require("crypto");
  return randomBytes(32);
}
