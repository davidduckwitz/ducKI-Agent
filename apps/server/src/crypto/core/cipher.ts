import crypto from "node:crypto";

export class CipherService {
  private static readonly ALGORITHM = "aes-256-gcm";
  private static readonly TAG_LENGTH = 16;
  private static readonly IV_LENGTH = 16;
  private static readonly SALT_LENGTH = 32;

  static deriveKey(password: string, salt?: Buffer): { key: Buffer; salt: Buffer } {
    const saltToUse = salt || crypto.randomBytes(this.SALT_LENGTH);
    const key = crypto.pbkdf2Sync(password, saltToUse, 100000, 32, "sha256");
    return { key, salt: saltToUse };
  }

  static encrypt(data: string, masterKey: Buffer): string {
    const iv = crypto.randomBytes(this.IV_LENGTH);
    const cipher = crypto.createCipheriv(this.ALGORITHM, masterKey, iv);

    let encrypted = cipher.update(data, "utf8", "hex");
    encrypted += cipher.final("hex");

    const tag = cipher.getAuthTag();
    const combined = Buffer.concat([iv, tag, Buffer.from(encrypted, "hex")]);

    return combined.toString("base64");
  }

  static decrypt(encrypted: string, masterKey: Buffer): string {
    const combined = Buffer.from(encrypted, "base64");

    const iv = combined.subarray(0, this.IV_LENGTH);
    const tag = combined.subarray(this.IV_LENGTH, this.IV_LENGTH + this.TAG_LENGTH);
    const ciphertext = combined.subarray(this.IV_LENGTH + this.TAG_LENGTH);

    const decipher = crypto.createDecipheriv(this.ALGORITHM, masterKey, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString("utf8");
  }
}
