import { randomBytes } from "crypto";
import { BaseWallet, Address, Balance } from "./wallet-base";

export class BitcoinWallet extends BaseWallet {
  currency: "BTC" = "BTC";

  override async generateAddress(derivationPath?: string): Promise<Address> {
    const randomPart = randomBytes(20).toString("hex");
    const address = `1${randomPart.slice(0, 33)}`;

    return {
      currency: "BTC",
      address,
      publicKey: randomBytes(33).toString("hex"),
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

    const randomPart = randomBytes(20).toString("hex");
    const address = `1${randomPart.slice(0, 33)}`;

    return {
      currency: "BTC",
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
    return address.startsWith("1") && address.length === 34;
  }

  override getDecimals(): number {
    return 8;
  }
}
