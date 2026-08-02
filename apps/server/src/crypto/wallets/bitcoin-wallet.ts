import { ECPairFactory } from "ecpair";
import { payments, networks } from "bitcoinjs-lib";
import * as tinysecp from "tiny-secp256k1";
import { randomBytes } from "crypto";
import { BaseWallet, Address, Balance } from "./wallet-base.js";

const ECPair = ECPairFactory(tinysecp);

export class BitcoinWallet extends BaseWallet {
  currency: "BTC" = "BTC";
  private network = networks.bitcoin; // Mainnet

  override async generateAddress(derivationPath?: string): Promise<Address> {
    // Generate random private key
    const privateKey = randomBytes(32);
    const keyPair = ECPair.fromPrivateKey(privateKey);

    // Generate P2PKH address (Legacy - starts with 1)
    const { address } = payments.p2pkh({ pubkey: keyPair.publicKey });

    if (!address) throw new Error("Failed to generate Bitcoin address");

    return {
      currency: "BTC",
      address,
      publicKey: Buffer.from(keyPair.publicKey).toString("hex"),
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

  override async importPrivateKey(privateKeyHex: string, label: string): Promise<Address> {
    try {
      // Create keyPair from private key (hex or WIF)
      let keyPair: ReturnType<typeof ECPair.fromPrivateKey>;

      if (privateKeyHex.length === 64) {
        // Hex format
        const privateKey = Buffer.from(privateKeyHex, "hex");
        keyPair = ECPair.fromPrivateKey(privateKey);
      } else {
        // WIF format
        keyPair = ECPair.fromWIF(privateKeyHex);
      }

      const { address } = payments.p2pkh({ pubkey: keyPair.publicKey });

      if (!address) throw new Error("Failed to generate address from private key");

      return {
        currency: "BTC",
        address,
        publicKey: Buffer.from(keyPair.publicKey).toString("hex"),
        label,
        balance: "0",
      };
    } catch (error) {
      throw new Error(`Invalid Bitcoin private key: ${error instanceof Error ? error.message : String(error)}`);
    }
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
