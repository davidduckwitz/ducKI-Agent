import { randomBytes } from "crypto";
import { BaseWallet, Address, Balance } from "./wallet-base";

export class EthereumWallet extends BaseWallet {
  currency: "ETH" = "ETH";

  override async generateAddress(derivationPath?: string): Promise<Address> {
    const randomAddr = randomBytes(20).toString("hex");
    const address = `0x${randomAddr}`;

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

    const randomAddr = randomBytes(20).toString("hex");
    const address = `0x${randomAddr}`;

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
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  override getDecimals(): number {
    return 18;
  }
}
