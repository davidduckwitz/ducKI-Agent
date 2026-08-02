import { ethers } from "ethers";
import { BaseWallet, Address, Balance } from "./wallet-base.js";

export class EthereumWallet extends BaseWallet {
  currency: "ETH" = "ETH";

  override async generateAddress(derivationPath?: string): Promise<Address> {
    // Generate a new random wallet
    const wallet = ethers.Wallet.createRandom();

    // Get EIP-55 checksummed address
    const address = ethers.getAddress(wallet.address);

    return {
      currency: "ETH",
      address,
      publicKey: wallet.signingKey.publicKey,
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

  override async importPrivateKey(privateKeyHex: string, label: string): Promise<Address> {
    try {
      // Create wallet from private key
      let wallet: ethers.Wallet;

      if (privateKeyHex.startsWith("0x")) {
        wallet = new ethers.Wallet(privateKeyHex);
      } else {
        wallet = new ethers.Wallet("0x" + privateKeyHex);
      }

      // Get EIP-55 checksummed address
      const address = ethers.getAddress(wallet.address);

      return {
        currency: "ETH",
        address,
        publicKey: wallet.signingKey.publicKey,
        label,
        balance: "0",
      };
    } catch (error) {
      throw new Error(`Invalid Ethereum private key: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  override async exportAddress(address: string): Promise<{ address: string; publicKey?: string }> {
    return { address, publicKey: "" };
  }

  override validateAddress(address: string): boolean {
    try {
      // ethers.getAddress validates and returns checksummed address
      ethers.getAddress(address);
      return true;
    } catch {
      return false;
    }
  }

  override getDecimals(): number {
    return 18;
  }
}
