import { randomBytes } from "crypto";
import * as secp256k1 from "tiny-secp256k1";

export function generateKeyPair() {
  const privateKey = randomBytes(32);
  const publicKeyUint8 = secp256k1.pointFromScalar(privateKey);

  if (!publicKeyUint8) throw new Error("Failed to generate public key");

  const publicKey = Buffer.from(publicKeyUint8);
  return { privateKey, publicKey };
}

export function signMessage(message: Buffer, privateKey: Buffer): Buffer {
  const hash = Buffer.from(message);
  const signature = secp256k1.sign(hash, privateKey);

  if (!signature) throw new Error("Failed to sign message");

  return Buffer.from(signature);
}

export function verifySignature(message: Buffer, signature: Buffer, publicKey: Buffer): boolean {
  const hash = Buffer.from(message);
  return secp256k1.verify(hash, publicKey, signature);
}

export function deriveChildKey(parentKey: Buffer, index: number): Buffer {
  const buffer = Buffer.concat([parentKey, Buffer.from([index >> 24, index >> 16, index >> 8, index])]);
  return buffer.slice(0, 32);
}
