export type Address = {
  currency: "BTC" | "ETH" | "XRP";
  address: string;
  publicKey?: string;
  label?: string;
  derivationPath?: string;
  balance?: string;
}

export interface Balance {
  address: string;
  balance: string;
  unit: string;
}

export interface Transaction {
  hash: string;
  from: string;
  to: string;
  amount: string;
  fee?: string;
  status: "pending" | "confirmed" | "failed";
}

export interface TransactionStatus {
  hash: string;
  status: "pending" | "confirmed" | "failed";
  confirmations?: number;
}

export abstract class BaseWallet {
  abstract currency: "BTC" | "ETH" | "XRP";

  abstract generateAddress(derivationPath?: string): Promise<Address>;
  abstract getBalance(address: string): Promise<Balance>;
  abstract broadcastTransaction(tx: string): Promise<string>;
  abstract importPrivateKey(key: string, label: string): Promise<Address>;
  abstract exportAddress(address: string): Promise<{ address: string; publicKey?: string }>;

  validateAddress(address: string): boolean {
    return !!address && address.length > 5;
  }

  getDecimals(): number {
    return 8;
  }
}
