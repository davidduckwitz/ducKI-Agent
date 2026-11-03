/**
 * Lazy loaders for the wallet libraries. They are not shipped in the desktop installer - the
 * "crypto-wallets" component pack provides them on demand - so nothing here may be imported
 * statically: the server must start (and list wallets) without them.
 */
import { loadOptionalModule } from "@ducki/shared";
import type { ECPairAPI } from "ecpair";

export const loadEthers = () => loadOptionalModule("ethers", () => import("ethers"));
export const loadXrpl = () => loadOptionalModule("xrpl", () => import("xrpl"));
export const loadBitcoinjs = () => loadOptionalModule("bitcoinjs-lib", () => import("bitcoinjs-lib"));

let ecpair: Promise<ECPairAPI> | undefined;
export function loadECPair(): Promise<ECPairAPI> {
  ecpair ??= (async () => {
    const [{ ECPairFactory }, tinysecp] = await Promise.all([
      loadOptionalModule("ecpair", () => import("ecpair")),
      loadOptionalModule("tiny-secp256k1", () => import("tiny-secp256k1")),
    ]);
    return ECPairFactory(tinysecp);
  })();
  // A failed load (pack not installed yet) must not stick - retry after installation.
  ecpair.catch(() => (ecpair = undefined));
  return ecpair;
}
