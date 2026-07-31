import crypto from "node:crypto";
import { generateMnemonic as generateBip39Mnemonic, validateMnemonic as validateBip39Mnemonic } from "bip39";

export class RandomService {
  static generateSecureRandom(bytes: number = 32): Buffer {
    return crypto.randomBytes(bytes);
  }

  static generateSecureRandomHex(bytes: number = 32): string {
    return this.generateSecureRandom(bytes).toString("hex");
  }

  static generateMnemonic(wordCount: 12 | 24 = 12): string {
    const entropy = wordCount === 12 ? 128 : 256;
    return generateBip39Mnemonic(entropy);
  }

  static validateMnemonic(mnemonic: string): boolean {
    return validateBip39Mnemonic(mnemonic);
  }

  static generateNonce(bytes: number = 16): string {
    return this.generateSecureRandom(bytes).toString("hex");
  }
}
