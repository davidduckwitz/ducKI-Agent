import { randomBytes, createHash } from "crypto";
import { BaseWallet, Address, Balance } from "./wallet-base";

// Base58 alphabet (XRP uses this)
const BASE58_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

function encodeBase58Xrp(buffer: Buffer): string {
  let num = 0n;
  for (const byte of buffer) {
    num = num * 256n + BigInt(byte);
  }

  const encoded: string[] = [];
  while (num > 0n) {
    const idx = Number(num % 58n);
    const char = BASE58_ALPHABET[idx];
    if (char) encoded.unshift(char);
    num = num / 58n;
  }

  for (const byte of buffer) {
    if (byte === 0) encoded.unshift("r");
    else break;
  }

  return encoded.length === 0 ? "r" : encoded.join("");
}

function generateXrpAddress(): string {
  const accountId = randomBytes(20);
  // Version byte 0x00 for mainnet
  const versioned = Buffer.concat([Buffer.from([0x00]), accountId]);

  // Double SHA256 for checksum
  const hash1 = createHash("sha256").update(versioned).digest();
  const hash2 = createHash("sha256").update(hash1).digest();
  const checksum = hash2.slice(0, 4);

  const full = Buffer.concat([versioned, checksum]);
  return encodeBase58Xrp(full);
}

export class XRPWallet extends BaseWallet {
  currency: "XRP" = "XRP";

  override async generateAddress(derivationPath?: string): Promise<Address> {
    const address = generateXrpAddress();

    return {
      currency: "XRP",
      address,
      publicKey: randomBytes(33).toString("hex"),
      derivationPath: derivationPath || "m/44'/144'/0'/0/0",
      balance: "0",
    };
  }

  override async getBalance(address: string): Promise<Balance> {
    return { address, balance: "0", unit: "drop" };
  }

  override async broadcastTransaction(tx: string): Promise<string> {
    throw new Error("Transaction broadcasting requires provider/API");
  }

  override async importPrivateKey(seed: string, label: string): Promise<Address> {
    if (!seed.startsWith("s")) throw new Error("Invalid XRP seed format");

    const address = generateXrpAddress();

    return {
      currency: "XRP",
      address,
      publicKey: randomBytes(33).toString("hex"),
      label,
      balance: "0",
    };
  }

  override async exportAddress(address: string): Promise<{ address: string; publicKey?: string }> {
    return { address, publicKey: "" };
  }

  override validateAddress(address: string): boolean {
    // XRP addresses start with 'r' and are 25-34 chars, using Base58
    if (!address.startsWith("r") || address.length < 25 || address.length > 34) {
      return false;
    }
    return /^r[a-zA-Z0-9]{24,33}$/.test(address);
  }

  override getDecimals(): number {
    return 6;
  }
}
