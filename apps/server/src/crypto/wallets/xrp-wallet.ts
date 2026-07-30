import { Wallet } from "xrpl";
import { BaseWallet, Address, Balance } from "./wallet-base";

export class XRPWallet extends BaseWallet {
  currency: "XRP" = "XRP";

  override async generateAddress(derivationPath?: string): Promise<Address> {
    // Generate a new random XRP wallet
    const wallet = Wallet.generate();

    return {
      currency: "XRP",
      address: wallet.address,
      publicKey: wallet.publicKey,
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
    try {
      // XRP Ledger uses seed format (starts with 's')
      const wallet = Wallet.fromSeed(seed);

      return {
        currency: "XRP",
        address: wallet.address,
        publicKey: wallet.publicKey,
        label,
        balance: "0",
      };
    } catch (error) {
      throw new Error(`Invalid XRP seed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  override async exportAddress(address: string): Promise<{ address: string; publicKey?: string }> {
    return { address, publicKey: "" };
  }

  override validateAddress(address: string): boolean {
    // XRP addresses start with 'r' and are valid Base58Check
    try {
      // Simple validation - starts with 'r' and has valid Base58 characters
      if (!address.startsWith("r") || address.length < 25 || address.length > 34) {
        return false;
      }
      return /^r[a-zA-Z0-9]{24,33}$/.test(address);
    } catch {
      return false;
    }
  }

  override getDecimals(): number {
    return 6;
  }
}
