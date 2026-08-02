export type { Address, Balance, Transaction, TransactionStatus } from "./wallet-base.js";
export { BaseWallet } from "./wallet-base.js";
export { BitcoinWallet } from "./bitcoin-wallet.js";
export { EthereumWallet } from "./ethereum-wallet.js";
export { XRPWallet } from "./xrp-wallet.js";

import { BaseWallet } from "./wallet-base.js";
import { BitcoinWallet } from "./bitcoin-wallet.js";
import { EthereumWallet } from "./ethereum-wallet.js";
import { XRPWallet } from "./xrp-wallet.js";

export function getWallet(currency: "BTC" | "ETH" | "XRP"): BaseWallet {
  switch (currency) {
    case "BTC":
      return new BitcoinWallet();
    case "ETH":
      return new EthereumWallet();
    case "XRP":
      return new XRPWallet();
    default:
      throw new Error(`Unsupported currency: ${currency}`);
  }
}
