export { BaseWallet, Address, Balance, Transaction, TransactionStatus } from "./wallet-base";
export { BitcoinWallet } from "./bitcoin-wallet";
export { EthereumWallet } from "./ethereum-wallet";
export { XRPWallet } from "./xrp-wallet";

import { BaseWallet } from "./wallet-base";
import { BitcoinWallet } from "./bitcoin-wallet";
import { EthereumWallet } from "./ethereum-wallet";
import { XRPWallet } from "./xrp-wallet";

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
