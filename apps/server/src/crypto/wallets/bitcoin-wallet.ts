import { randomBytes, createHash } from "crypto";
import { BaseWallet, Address, Balance } from "./wallet-base";

// Base58 alphabet
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(buffer: Buffer): string {
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
    if (byte === 0) encoded.unshift("1");
    else break;
  }

  return encoded.join("");
}

function generateP2PKHAddress(publicKey: Buffer): string {
  const sha256 = createHash("sha256").update(publicKey).digest();
  const ripemd160 = createHash("ripemd160").update(sha256).digest();

  // Add version byte (0x00 for mainnet P2PKH)
  const versioned = Buffer.concat([Buffer.from([0x00]), ripemd160]);

  // Double SHA256 for checksum
  const hash1 = createHash("sha256").update(versioned).digest();
  const hash2 = createHash("sha256").update(hash1).digest();
  const checksum = hash2.slice(0, 4);

  // Concatenate and encode
  const full = Buffer.concat([versioned, checksum]);
  return encodeBase58(full);
}

export class BitcoinWallet extends BaseWallet {
  currency: "BTC" = "BTC";

  override async generateAddress(derivationPath?: string): Promise<Address> {
    const privateKey = randomBytes(32);
    // Generate public key from private (simplified - in production use proper EC)
    const publicKey = randomBytes(33); // Mock public key
    const address = generateP2PKHAddress(publicKey);

    return {
      currency: "BTC",
      address,
      publicKey: publicKey.toString("hex"),
      derivationPath: derivationPath || "m/44'/0'/0'/0/0",
      balance: "0",
    };
  }

  override async getBalance(address: string): Promise<Balance> {
    return { address, balance: "0", unit: "satoshi" };
  }

  override async broadcastTransaction(tx: string): Promise<string> {
    throw new Error("Transaction broadcasting requires provider/API");
  }

  override async importPrivateKey(key: string, label: string): Promise<Address> {
    if (!key || key.length < 10) throw new Error("Invalid private key");

    const publicKey = randomBytes(33);
    const address = generateP2PKHAddress(publicKey);

    return {
      currency: "BTC",
      address,
      publicKey: publicKey.toString("hex"),
      label,
      balance: "0",
    };
  }

  override async exportAddress(address: string): Promise<{ address: string; publicKey?: string }> {
    return { address, publicKey: "" };
  }

  override validateAddress(address: string): boolean {
    // Check if it's a valid P2PKH address (starts with 1)
    // and is reasonable length (26-35 chars typically)
    if (!address.startsWith("1") || address.length < 26 || address.length > 35) {
      return false;
    }

    // Check if all characters are valid Base58
    return /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(address);
  }

  override getDecimals(): number {
    return 8;
  }
}
