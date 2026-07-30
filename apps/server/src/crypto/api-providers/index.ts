export { BlockchainApiProvider, Fee } from "./blockchain-api.js";
export { BitrefProvider } from "./bitref-provider.js";

import { BlockchainApiProvider } from "./blockchain-api.js";
import { BitrefProvider } from "./bitref-provider.js";

export function getApiProvider(
  provider: "bitref" | "etherscan" | "xrpscan",
  apiKey: string,
  apiSecret?: string
): BlockchainApiProvider {
  switch (provider) {
    case "bitref":
      return new BitrefProvider(apiKey);
    case "etherscan":
      return new EtherscanProviderStub(apiKey);
    case "xrpscan":
      return new XRPScanProviderStub(apiKey);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// Placeholder implementations for other providers
class EtherscanProviderStub extends BlockchainApiProvider {
  provider = "etherscan";
  constructor(private apiKey: string) {
    super();
  }
  async getBalance(): Promise<{ address: string; balance: string; unit: string }> {
    throw new Error("Etherscan provider not yet implemented");
  }
  async getTransactions(): Promise<any[]> {
    throw new Error("Etherscan provider not yet implemented");
  }
  async getTransactionStatus(): Promise<any> {
    throw new Error("Etherscan provider not yet implemented");
  }
  async estimateFee(): Promise<any> {
    throw new Error("Etherscan provider not yet implemented");
  }
  async broadcastTransaction(): Promise<string> {
    throw new Error("Etherscan provider not yet implemented");
  }
}

class XRPScanProviderStub extends BlockchainApiProvider {
  provider = "xrpscan";
  constructor(private apiKey: string) {
    super();
  }
  async getBalance(): Promise<{ address: string; balance: string; unit: string }> {
    throw new Error("XRPScan provider not yet implemented");
  }
  async getTransactions(): Promise<any[]> {
    throw new Error("XRPScan provider not yet implemented");
  }
  async getTransactionStatus(): Promise<any> {
    throw new Error("XRPScan provider not yet implemented");
  }
  async estimateFee(): Promise<any> {
    throw new Error("XRPScan provider not yet implemented");
  }
  async broadcastTransaction(): Promise<string> {
    throw new Error("XRPScan provider not yet implemented");
  }
}
