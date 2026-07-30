export { BlockchainApiProvider, Fee } from "./blockchain-api";

import { BlockchainApiProvider } from "./blockchain-api";

export function getApiProvider(
  provider: "bitref" | "etherscan" | "xrpscan",
  apiKey: string,
  apiSecret?: string
): BlockchainApiProvider {
  // Placeholder implementation
  // In production, would return actual provider instances
  throw new Error(`Provider ${provider} not yet implemented`);
}
