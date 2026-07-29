import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";

/**
 * Represents a single credential (API key) with metadata
 */
export interface Credential {
  id: string;
  provider: string;
  key: string;
  displayName: string;
  isActive: boolean;
  createdAt: number;
  lastUsedAt?: number;
  successCount: number;
  failureCount: number;
  isRotated: boolean;
}

/**
 * Configuration for credential rotation
 */
export interface CredentialRotationConfig {
  enabled: boolean;
  maxFailuresBeforeRotation: number;
  minTimeBetweenRotations: number; // milliseconds
  maxCredentialsPerProvider: number;
  rotateOnUnauthorized: boolean;
  rotateOnBillingError: boolean;
  retryAfterRotation: boolean;
}

/**
 * Manages API credentials across multiple providers with rotation support
 *
 * Features:
 * - Multiple credentials per provider with active/fallback chains
 * - Failure tracking per credential
 * - Automatic rotation on errors
 * - Secure credential storage interface
 * - Rotation strategy configuration
 */
export class CredentialManager {
  private logger: Logger;
  private credentials: Map<string, Credential[]> = new Map();
  private activeCredential: Map<string, string> = new Map(); // provider -> credentialId
  private lastRotation: Map<string, number> = new Map(); // provider -> timestamp
  private rotationConfig: CredentialRotationConfig;

  constructor(rotationConfig?: Partial<CredentialRotationConfig>) {
    this.logger = getRootLogger().child("CredentialManager");

    // Default config
    const defaults: CredentialRotationConfig = {
      enabled: true,
      maxFailuresBeforeRotation: 5,
      minTimeBetweenRotations: 60000, // 1 minute
      maxCredentialsPerProvider: 3,
      rotateOnUnauthorized: true,
      rotateOnBillingError: false, // Billing errors are usually account-level, not key-level
      retryAfterRotation: true,
    };

    this.rotationConfig = { ...defaults, ...rotationConfig };
    this.logger.info("CredentialManager initialized", { config: this.rotationConfig });
  }

  /**
   * Register a credential for a provider
   */
  registerCredential(credential: Omit<Credential, "isActive" | "successCount" | "failureCount">): void {
    const fullCredential: Credential = {
      ...credential,
      isActive: true,
      successCount: 0,
      failureCount: 0,
    };

    if (!this.credentials.has(credential.provider)) {
      this.credentials.set(credential.provider, []);
    }

    const providerCredentials = this.credentials.get(credential.provider)!;
    providerCredentials.push(fullCredential);

    // Set as active if first credential
    if (providerCredentials.length === 1) {
      this.activeCredential.set(credential.provider, credential.id);
    }

    // Enforce max credentials limit
    if (providerCredentials.length > this.rotationConfig.maxCredentialsPerProvider) {
      const toRemove = providerCredentials.shift()!;
      this.logger.warn(`Removed oldest credential for ${credential.provider}`, {
        removedId: toRemove.id,
        remainingCount: providerCredentials.length,
      });
    }

    this.logger.info(`Registered credential for ${credential.provider}`, {
      credentialId: credential.id,
      displayName: credential.displayName,
      totalForProvider: providerCredentials.length,
    });
  }

  /**
   * Get active credential for a provider
   */
  getActiveCredential(provider: string): Credential | null {
    const credentialId = this.activeCredential.get(provider);
    if (!credentialId) return null;

    const credentials = this.credentials.get(provider);
    if (!credentials) return null;

    return credentials.find((c) => c.id === credentialId) ?? null;
  }

  /**
   * Get all credentials for a provider
   */
  getAllCredentials(provider: string): Credential[] {
    return this.credentials.get(provider) ?? [];
  }

  /**
   * Record successful request with active credential
   */
  recordSuccess(provider: string): void {
    const active = this.getActiveCredential(provider);
    if (active) {
      active.successCount++;
      active.lastUsedAt = Date.now();
    }
  }

  /**
   * Record failed request and potentially rotate credentials
   */
  async recordFailure(provider: string, errorCategory: string): Promise<boolean> {
    const active = this.getActiveCredential(provider);
    if (!active) {
      this.logger.warn(`No active credential for ${provider} to record failure`);
      return false;
    }

    active.failureCount++;
    active.lastUsedAt = Date.now();

    // Determine if rotation is warranted
    const shouldRotate = this.shouldRotateCredential(errorCategory);
    if (!shouldRotate) {
      return false;
    }

    return this.rotateCredential(provider);
  }

  /**
   * Determine if an error category warrants credential rotation
   */
  private shouldRotateCredential(errorCategory: string): boolean {
    if (!this.rotationConfig.enabled) return false;

    if (this.rotationConfig.rotateOnUnauthorized && errorCategory === "Unauthorized") {
      return true;
    }

    if (this.rotationConfig.rotateOnBillingError && errorCategory === "BillingExhausted") {
      return true;
    }

    return false;
  }

  /**
   * Attempt to rotate to next available credential
   */
  async rotateCredential(provider: string): Promise<boolean> {
    // Check rotation rate limiting
    const lastRotation = this.lastRotation.get(provider) ?? 0;
    const timeSinceLastRotation = Date.now() - lastRotation;

    if (timeSinceLastRotation < this.rotationConfig.minTimeBetweenRotations) {
      this.logger.debug(`Rotation rate limit: ${provider}`, {
        timeSinceLastRotation,
        minRequired: this.rotationConfig.minTimeBetweenRotations,
      });
      return false;
    }

    const credentials = this.credentials.get(provider);
    if (!credentials || credentials.length === 0) {
      this.logger.error(`No credentials available for rotation: ${provider}`);
      return false;
    }

    const currentActiveId = this.activeCredential.get(provider);
    const currentIndex = credentials.findIndex((c) => c.id === currentActiveId);

    // Find next healthy (unrotated or with low failure count) credential
    for (let i = 1; i < credentials.length; i++) {
      const nextIndex = (currentIndex + i) % credentials.length;
      const candidate = credentials[nextIndex]!;

      // Skip if already rotated recently or has too many failures
      if (candidate.isRotated || candidate.failureCount > this.rotationConfig.maxFailuresBeforeRotation) {
        continue;
      }

      // Switch to this credential
      this.activeCredential.set(provider, candidate.id);
      this.lastRotation.set(provider, Date.now());

      this.logger.info(`Rotated credential for ${provider}`, {
        from: currentActiveId,
        to: candidate.id,
        displayName: candidate.displayName,
      });

      return true;
    }

    this.logger.error(`No healthy credentials available for rotation: ${provider}`);
    return false;
  }

  /**
   * Update rotation configuration at runtime
   */
  updateRotationConfig(config: Partial<CredentialRotationConfig>): void {
    this.rotationConfig = { ...this.rotationConfig, ...config };
    this.logger.info("Rotation configuration updated", { config: this.rotationConfig });
  }

  /**
   * Get rotation status for a provider
   */
  getRotationStatus(provider: string): {
    activeCredentialId: string | null;
    totalCredentials: number;
    lastRotation: number | null;
    canRotate: boolean;
  } {
    const active = this.getActiveCredential(provider);
    const credentials = this.credentials.get(provider) ?? [];
    const lastRot = this.lastRotation.get(provider);
    const timeSinceLastRotation = lastRot ? Date.now() - lastRot : Infinity;
    const canRotate = timeSinceLastRotation >= this.rotationConfig.minTimeBetweenRotations;

    return {
      activeCredentialId: active?.id ?? null,
      totalCredentials: credentials.length,
      lastRotation: lastRot ?? null,
      canRotate,
    };
  }

  /**
   * Reset all failure counts (after successful recovery)
   */
  resetFailureCounts(provider: string): void {
    const credentials = this.credentials.get(provider);
    if (!credentials) return;

    credentials.forEach((c) => {
      c.failureCount = 0;
    });

    this.logger.info(`Reset failure counts for ${provider}`);
  }

  /**
   * Export all credentials (for backup/export)
   */
  exportCredentials(): Record<string, Credential[]> {
    const exported: Record<string, Credential[]> = {};
    this.credentials.forEach((creds, provider) => {
      exported[provider] = creds.map((c) => ({ ...c }));
    });
    return exported;
  }

  /**
   * Import credentials from backup
   */
  importCredentials(data: Record<string, Credential[]>): void {
    this.credentials.clear();
    this.activeCredential.clear();

    Object.entries(data).forEach(([provider, creds]) => {
      creds.forEach((c) => {
        this.registerCredential({
          id: c.id,
          provider: c.provider,
          key: c.key,
          displayName: c.displayName,
          createdAt: c.createdAt,
          isRotated: c.isRotated,
        });
      });
    });

    this.logger.info("Credentials imported");
  }
}
