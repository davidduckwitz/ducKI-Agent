import { randomBytes, createHash } from "crypto";
import { BaseWallet, Address, Balance } from "./wallet-base";

function generateEthereumAddress(): string {
  const publicKey = randomBytes(64);
  const hash = createHash("sha256").update(publicKey).digest();
  const addressBytes = hash.slice(-20);
  const hexAddress = "0x" + addressBytes.toString("hex");

  // Simple checksum: use first 20 bytes of sha256
  const addr = hexAddress.slice(2).toLowerCase();
  const hashHex = createHash("sha256").update(addr).digest("hex");

  let checksummed = "0x";
  for (let i = 0; i < addr.length; i++) {
    const hashChar = hashHex[i];
    const addrChar = addr[i];
    if (hashChar !== undefined && addrChar !== undefined) {
      const hashValue = parseInt(hashChar, 16);
      checksummed += hashValue >= 8 ? addrChar.toUpperCase() : addrChar;
    }
  }
  return checksummed;
}

export class EthereumWallet extends BaseWallet {
  currency: "ETH" = "ETH";

  override async generateAddress(derivationPath?: string): Promise<Address> {
    const address = generateEthereumAddress();

    return {
      currency: "ETH",
      address,
      publicKey: randomBytes(65).toString("hex"),
      derivationPath: derivationPath || "m/44'/60'/0'/0/0",
      balance: "0",
    };
  }

  override async getBalance(address: string): Promise<Balance> {
    return { address, balance: "0", unit: "wei" };
  }

  override async broadcastTransaction(tx: string): Promise<string> {
    throw new Error("Transaction broadcasting requires provider/API");
  }

  override async importPrivateKey(key: string, label: string): Promise<Address> {
    if (!key || key.length < 10) throw new Error("Invalid private key");

    const address = generateEthereumAddress();

    return {
      currency: "ETH",
      address,
      publicKey: randomBytes(65).toString("hex"),
      label,
      balance: "0",
    };
  }

  override async exportAddress(address: string): Promise<{ address: string; publicKey?: string }> {
    return { address, publicKey: "" };
  }

  override validateAddress(address: string): boolean {
    // Ethereum address validation: 0x followed by 40 hex chars
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  override getDecimals(): number {
    return 18;
  }
}
