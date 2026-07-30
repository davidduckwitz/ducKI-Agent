import { DatabaseService } from "@ducki/database";
import * as schema from "@ducki/database";
import { eq } from "drizzle-orm";
import { getWallet } from "../crypto/wallets/index.js";
import { getApiProvider } from "../crypto/api-providers/index.js";

export interface CryptoAddress {
  id?: number;
  currency: "BTC" | "ETH" | "XRP";
  address: string;
  publicKey?: string;
  label?: string;
  balance?: string;
  createdAt?: string;
  updatedAt?: string;
}

export class CryptoService {
  private db: any;

  constructor(database: DatabaseService) {
    this.db = (database as any).raw;
  }

  async createAddress(
    currency: "BTC" | "ETH" | "XRP",
    label?: string,
    derivationPath?: string
  ): Promise<CryptoAddress> {
    const wallet = getWallet(currency);
    const walletAddress = await wallet.generateAddress(derivationPath);

    const now = new Date().toISOString();

    try {
      const result = await this.db
        .insert(schema.cryptoAddresses)
        .values({
          currency: walletAddress.currency,
          address: walletAddress.address,
          publicKey: walletAddress.publicKey,
          label,
          balance: walletAddress.balance || "0",
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      return result || walletAddress;
    } catch (error) {
      console.error("Failed to save address to DB:", error);
      return walletAddress;
    }
  }

  async getAddresses(currency?: "BTC" | "ETH" | "XRP"): Promise<CryptoAddress[]> {
    try {
      if (currency) {
        return await this.db
          .select()
          .from(schema.cryptoAddresses)
          .where(eq(schema.cryptoAddresses.currency, currency))
          .all();
      }
      return await this.db
        .select()
        .from(schema.cryptoAddresses)
        .all();
    } catch (error) {
      console.error("Failed to fetch addresses:", error);
      return [];
    }
  }

  async getAddressById(id: number): Promise<CryptoAddress | null> {
    try {
      return (
        (await this.db
          .select()
          .from(schema.cryptoAddresses)
          .where(eq(schema.cryptoAddresses.id, id))
          .get()) || null
      );
    } catch (error) {
      console.error("Failed to fetch address:", error);
      return null;
    }
  }

  async importPrivateKey(
    currency: "BTC" | "ETH" | "XRP",
    privateKey: string,
    label: string
  ): Promise<CryptoAddress> {
    const wallet = getWallet(currency);
    const walletAddress = await wallet.importPrivateKey(privateKey, label);

    const now = new Date().toISOString();

    try {
      const result = await this.db
        .insert(schema.cryptoAddresses)
        .values({
          currency: walletAddress.currency,
          address: walletAddress.address,
          publicKey: walletAddress.publicKey,
          label: walletAddress.label,
          balance: walletAddress.balance || "0",
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      return result || walletAddress;
    } catch (error) {
      console.error("Failed to save imported address:", error);
      return walletAddress;
    }
  }

  async updateAddressLabel(id: number, label: string): Promise<void> {
    try {
      await this.db
        .update(schema.cryptoAddresses)
        .set({ label, updatedAt: new Date().toISOString() })
        .where(eq(schema.cryptoAddresses.id, id))
        .run();
    } catch (error) {
      console.error("Failed to update address label:", error);
    }
  }

  async deleteAddress(id: number): Promise<void> {
    try {
      await this.db
        .delete(schema.cryptoAddresses)
        .where(eq(schema.cryptoAddresses.id, id))
        .run();
    } catch (error) {
      console.error("Failed to delete address:", error);
    }
  }

  async getPortfolioSummary(): Promise<{
    totalUsd: number;
    holdings: Record<"BTC" | "ETH" | "XRP", { amount: string; usd: number }>;
  }> {
    try {
      const addresses = await this.getAddresses();

      const holdings: Record<"BTC" | "ETH" | "XRP", { amount: string; usd: number }> = {
        BTC: { amount: "0", usd: 0 },
        ETH: { amount: "0", usd: 0 },
        XRP: { amount: "0", usd: 0 },
      };

      let totalUsd = 0;

      for (const addr of addresses) {
        const balance = addr.balance || "0";
        const usd = 0; // TODO: Get from price API

        try {
          const existing = BigInt(holdings[addr.currency as "BTC" | "ETH" | "XRP"].amount || "0");
          const current = BigInt(balance);
          holdings[addr.currency as "BTC" | "ETH" | "XRP"].amount = (existing + current).toString();
        } catch {
          // Skip if balance parsing fails
        }

        holdings[addr.currency as "BTC" | "ETH" | "XRP"].usd += usd;
        totalUsd += usd;
      }

      return { totalUsd, holdings };
    } catch (error) {
      console.error("Failed to get portfolio summary:", error);
      return {
        totalUsd: 0,
        holdings: {
          BTC: { amount: "0", usd: 0 },
          ETH: { amount: "0", usd: 0 },
          XRP: { amount: "0", usd: 0 },
        },
      };
    }
  }

  async setApiCredentials(
    provider: "bitref" | "etherscan" | "xrpscan",
    apiKey: string,
    apiSecret?: string
  ): Promise<void> {
    try {
      const now = new Date().toISOString();
      // TODO: Encrypt apiKey and apiSecret
      await this.db
        .insert(schema.cryptoApiCredentials)
        .values({
          provider,
          encryptedApiKey: apiKey, // Should be encrypted
          encryptedApiSecret: apiSecret,
          isActive: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch (error) {
      console.error("Failed to save API credentials:", error);
    }
  }

  async testApiConnection(
    provider: "bitref" | "etherscan" | "xrpscan",
    apiKey: string,
    apiSecret?: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      const apiProvider = getApiProvider(provider, apiKey, apiSecret);

      // Test with a known Bitcoin address for Bitref
      if (provider === "bitref") {
        const testAddress = "1A1z7agoat5JNrGomQkqSCBeaSeixhn5h5"; // Satoshi's wallet
        const balance = await apiProvider.getBalance(testAddress);
        return {
          success: true,
          message: `Bitref API connection successful. Balance for test address: ${balance.balance} ${balance.unit}`,
        };
      }

      // Test with Etherscan
      if (provider === "etherscan") {
        const testAddress = "0x0000000000000000000000000000000000000000"; // Burn address
        const balance = await apiProvider.getBalance(testAddress);
        return {
          success: true,
          message: `Etherscan API connection successful. Balance for test address: ${balance.balance} ${balance.unit}`,
        };
      }

      // Test with XRP Ledger
      if (provider === "xrpscan") {
        const testAddress = "rN7n7otQDd6FczFgLdmqtXSVE7upbtykqd"; // Bitstamp wallet
        const balance = await apiProvider.getBalance(testAddress);
        return {
          success: true,
          message: `XRP Ledger API connection successful. Balance for test address: ${balance.balance} ${balance.unit}`,
        };
      }

      return { success: false, message: "Unknown provider" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        success: false,
        message: `API connection failed: ${message}`,
      };
    }
  }
}
