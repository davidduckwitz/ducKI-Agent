import crypto from "node:crypto";
import { keccak256 as keccak } from "ethereum-cryptography/keccak";
import { ripemd160 as ripemd } from "ethereum-cryptography/ripemd160";

export class HashService {
  static sha256(data: string | Buffer): Buffer {
    return crypto.createHash("sha256").update(data).digest();
  }

  static sha256Hex(data: string | Buffer): string {
    return this.sha256(data).toString("hex");
  }

  static doubleSha256(data: Buffer): Buffer {
    return this.sha256(this.sha256(data));
  }

  static keccak256(data: string | Buffer): Buffer {
    const input = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    return Buffer.from(keccak(input));
  }

  static keccak256Hex(data: string | Buffer): string {
    return this.keccak256(data).toString("hex");
  }

  static ripemd160(data: Buffer): Buffer {
    return Buffer.from(ripemd(data));
  }

  static hash160(data: Buffer): Buffer {
    return this.ripemd160(this.sha256(data));
  }

  static hash160Hex(data: Buffer): string {
    return this.hash160(data).toString("hex");
  }
}
