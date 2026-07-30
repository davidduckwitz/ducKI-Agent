import { Balance, Transaction, TransactionStatus } from "../wallets/wallet-base";

export interface Fee {
  fast: string;
  standard: string;
  slow: string;
}

export abstract class BlockchainApiProvider {
  abstract provider: string;

  abstract getBalance(address: string): Promise<Balance>;
  abstract getTransactions(address: string, limit?: number): Promise<Transaction[]>;
  abstract getTransactionStatus(hash: string): Promise<TransactionStatus>;
  abstract estimateFee(): Promise<Fee>;
  abstract broadcastTransaction(signedTx: string): Promise<string>;

  protected checkRateLimit(): void {
    // Rate limiting logic
  }
}
