import { BlockchainApiProvider, Fee } from "./blockchain-api";
import { Balance, Transaction, TransactionStatus } from "../wallets/wallet-base";

export class BitrefProvider extends BlockchainApiProvider {
  provider = "bitref";
  private apiKey: string;
  private baseUrl = "https://api.bitref.com/v1";
  private lastRequestTime = 0;
  private minRequestInterval = 100; // Rate limit: 600 req/min = 1 per 100ms

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  override async getBalance(address: string): Promise<Balance> {
    this.checkRateLimit();

    try {
      const response = await fetch(
        `${this.baseUrl}/address/${address}/balance`,
        {
          headers: {
            "X-API-Key": this.apiKey,
          },
        }
      );

      const data = (await response.json()) as {
        confirmed_balance?: number;
        unconfirmed_balance?: number;
        error?: string;
      };

      // Check for API error response
      if (data.error) {
        if (data.error.includes("not found in the allow list")) {
          throw new Error(
            "API key not registered with Bitref. Get a free API key at https://bitref.com/account/request/"
          );
        }
        throw new Error(`Bitref API error: ${data.error}`);
      }

      if (!response.ok) {
        if (response.status === 401) throw new Error("Invalid or unauthorized Bitref API key");
        if (response.status === 429) throw new Error("Bitref rate limit exceeded");
        throw new Error(`Bitref API error: ${response.statusText}`);
      }

      // Combine confirmed and unconfirmed balance
      const totalBalance = ((data.confirmed_balance || 0) + (data.unconfirmed_balance || 0)).toString();

      return {
        address,
        balance: totalBalance,
        unit: "satoshi",
      };
    } catch (error) {
      throw new Error(
        `Failed to fetch balance from Bitref: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  override async getTransactions(address: string, limit = 50): Promise<Transaction[]> {
    this.checkRateLimit();

    try {
      const response = await fetch(
        `${this.baseUrl}/address/${address}/transactions`,
        {
          headers: {
            "X-API-Key": this.apiKey,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Bitref API error: ${response.statusText}`);
      }

      const data = (await response.json()) as Array<{
        tx_hash?: string;
        height?: number;
        fee?: number;
        time?: number;
      }>;

      if (!Array.isArray(data)) return [];

      // Return up to 'limit' transactions
      return data.slice(0, limit).map((tx) => ({
        hash: tx.tx_hash || "",
        from: address, // Bitref doesn't provide sender/receiver in list
        to: address,
        amount: tx.fee ? String(tx.fee) : "0",
        status: tx.height ? ("confirmed" as const) : ("pending" as const),
        fee: tx.fee ? String(tx.fee) : undefined,
      }));
    } catch (error) {
      throw new Error(
        `Failed to fetch transactions from Bitref: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  override async getTransactionStatus(hash: string): Promise<TransactionStatus> {
    this.checkRateLimit();

    try {
      const response = await fetch(
        `${this.baseUrl}/tx/${hash}/status`,
        {
          headers: {
            "X-API-Key": this.apiKey,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Bitref API error: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        confirmed?: boolean;
        blockhash?: string;
        confirmations?: number;
        blocktime?: number;
      };

      return {
        hash,
        status: data.confirmed ? ("confirmed" as const) : ("pending" as const),
        confirmations: data.confirmations || (data.confirmed ? 1 : 0),
      };
    } catch (error) {
      throw new Error(
        `Failed to fetch transaction status from Bitref: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  override async estimateFee(): Promise<Fee> {
    this.checkRateLimit();

    try {
      const response = await fetch(
        `${this.baseUrl}/fees/estimates`,
        {
          headers: {
            "X-API-Key": this.apiKey,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Bitref fee estimation error: ${response.statusText}`);
      }

      const data = (await response.json()) as Record<string, number>;

      // Get fee rates for different confirmation targets
      // data is like { "1": 6.976, "2": 6.976, "3": 6.212, ... "144": 3.144 }
      return {
        fast: String(data["1"] || 6),        // 1 block confirmation
        standard: String(data["6"] || 4),    // 6 blocks
        slow: String(data["144"] || 2),      // ~144 blocks (24 hours)
      };
    } catch {
      // Fallback values if API fails
      return {
        fast: "6",
        standard: "4",
        slow: "2",
      };
    }
  }

  override async broadcastTransaction(signedTx: string): Promise<string> {
    this.checkRateLimit();

    try {
      const response = await fetch(
        `${this.baseUrl}/tx/broadcast`,
        {
          method: "POST",
          headers: {
            "X-API-Key": this.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ rawtx: signedTx }),
        }
      );

      if (!response.ok) {
        throw new Error(`Bitref broadcast error: ${response.statusText}`);
      }

      const data = (await response.json()) as { txid?: string };
      return data.txid || "";
    } catch (error) {
      throw new Error(
        `Failed to broadcast transaction: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  protected override checkRateLimit(): void {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      // In production, would wait or queue requests
      // For now just track the time
    }

    this.lastRequestTime = now;
  }
}
