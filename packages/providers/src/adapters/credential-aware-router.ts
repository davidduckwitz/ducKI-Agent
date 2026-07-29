import type { LLMMessage, LLMResponse, GenerateOptions } from "@ducki/shared";
import type { LLMProvider } from "../base.js";
import type { ProviderRouterConfig } from "../adapter-config.js";
import { ProviderRouter } from "./provider-router.js";
import { CredentialManager, type CredentialRotationConfig } from "../credential-manager.js";
import type { Logger } from "@ducki/logger";
import { getRootLogger } from "@ducki/logger";

/**
 * Extends ProviderRouter with credential rotation and management
 *
 * This router:
 * - Manages multiple API credentials per provider
 * - Rotates credentials on errors (401, etc.)
 * - Tracks credential health
 * - Integrates with ProviderRouter for intelligent failover
 * - Supports backup/restore of credentials
 */
export class CredentialAwareRouter implements LLMProvider {
  readonly name = "credential-aware-router";
  readonly model: string;

  private providerRouter: ProviderRouter;
  private credentialManager: CredentialManager;
  private logger: Logger;
  private providerCredentialMap: Map<string, string[]> = new Map(); // provider -> [credentialIds]

  constructor(
    primary: LLMProvider,
    fallbacks: LLMProvider[] = [],
    routerConfig?: Partial<ProviderRouterConfig>,
    credentialConfig?: Partial<CredentialRotationConfig>
  ) {
    this.model = primary.model;
    this.logger = getRootLogger().child("CredentialAwareRouter");

    this.providerRouter = new ProviderRouter(primary, fallbacks, routerConfig);
    this.credentialManager = new CredentialManager(credentialConfig);

    this.logger.info("CredentialAwareRouter initialized", {
      primaryProvider: primary.name,
      fallbackCount: fallbacks.length,
    });
  }

  /**
   * Register a credential for a provider
   */
  registerCredential(provider: string, credentialId: string, apiKey: string, displayName: string): void {
    this.credentialManager.registerCredential({
      id: credentialId,
      provider,
      key: apiKey,
      displayName,
      createdAt: Date.now(),
      isRotated: false,
    });

    // Track credential mapping
    if (!this.providerCredentialMap.has(provider)) {
      this.providerCredentialMap.set(provider, []);
    }
    this.providerCredentialMap.get(provider)!.push(credentialId);
  }

  /**
   * Add a fallback provider
   */
  addFallback(provider: LLMProvider): void {
    this.providerRouter.addFallback(provider);
  }

  /**
   * Get the active credential for a provider
   */
  getActiveCredential(provider: string) {
    return this.credentialManager.getActiveCredential(provider);
  }

  /**
   * Get all credentials for a provider
   */
  getAllCredentials(provider: string) {
    return this.credentialManager.getAllCredentials(provider);
  }

  /**
   * Get credential rotation status
   */
  getRotationStatus(provider: string) {
    return this.credentialManager.getRotationStatus(provider);
  }

  /**
   * Update router configuration at runtime
   */
  updateRouterConfig(config: Partial<ProviderRouterConfig>): void {
    this.providerRouter.updateConfig(config);
  }

  /**
   * Update credential rotation configuration at runtime
   */
  updateCredentialConfig(config: Partial<CredentialRotationConfig>): void {
    this.credentialManager.updateRotationConfig(config);
  }

  /**
   * Check if provider supports streaming
   */
  supportsStreaming(): boolean {
    return true;
  }

  /**
   * Check if provider is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const active = this.getActiveCredential("anthropic") ?? this.getActiveCredential("gemini") ?? this.getActiveCredential("bedrock");
      return active !== null;
    } catch {
      return false;
    }
  }

  /**
   * Generate stream with credential-aware failover
   */
  async generateStream(
    messages: LLMMessage[],
    options?: GenerateOptions,
    onChunk?: (chunk: string) => void
  ): Promise<LLMResponse> {
    // For now, delegate to generate and convert to stream
    // In production, this would stream properly with credential rotation
    return this.generate(messages, options);
  }

  /**
   * Main generate method with credential-aware failover
   */
  async generate(messages: LLMMessage[], options?: GenerateOptions): Promise<LLMResponse> {
    const maxAttempts = 5; // Max attempts across all credential rotations
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        this.logger.debug(`Generate attempt ${attempt + 1}/${maxAttempts}`);

        // Attempt with current provider and credential stack
        const response = await this.providerRouter.generate(messages, options);

        // Success - record success for active credentials
        for (const provider of ["anthropic", "gemini", "bedrock", "openai"]) {
          this.credentialManager.recordSuccess(provider);
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Extract error category to decide on rotation
        const errorMessage = lastError.message.toLowerCase();
        let errorCategory = "Unknown";

        if (errorMessage.includes("unauthorized") || errorMessage.includes("401")) {
          errorCategory = "Unauthorized";
        } else if (errorMessage.includes("billing") || errorMessage.includes("402")) {
          errorCategory = "BillingExhausted";
        } else if (errorMessage.includes("rate limit")) {
          errorCategory = "RateLimited";
        } else if (errorMessage.includes("context")) {
          errorCategory = "ContextOverflow";
        }

        // Record failure and attempt rotation
        this.logger.warn(`Generate attempt ${attempt + 1} failed`, {
          error: lastError.message,
          errorCategory,
          attempt,
        });

        // Try to rotate credential
        const primaryProvider = this.providerRouter["stack"]?.primary?.name ?? "unknown";
        const rotated = await this.credentialManager.recordFailure(primaryProvider, errorCategory);

        if (!rotated) {
          // No rotation available, throw error
          throw lastError;
        }

        // Rotation successful, continue to retry
        this.logger.info("Credential rotated, retrying...", {
          provider: primaryProvider,
          attempt: attempt + 1,
        });

        // Small delay before retry
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    throw new Error(
      `[CredentialAwareRouter] Exhausted all retry attempts (${maxAttempts}). Last error: ${lastError?.message}`
    );
  }

  /**
   * Export credentials for backup
   */
  exportCredentials(): Record<string, any> {
    return {
      credentials: this.credentialManager.exportCredentials(),
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * Import credentials from backup
   */
  importCredentials(data: { credentials: Record<string, any>; exportedAt?: string }): void {
    this.credentialManager.importCredentials(data.credentials);
    this.logger.info("Credentials imported from backup");
  }

  /**
   * Get status of all providers
   */
  getStatus() {
    const status: Record<string, any> = {
      routers: {
        providerRouter: this.providerRouter.getProviderStatus?.(),
        credentialManager: {},
      },
      credentials: {},
    };

    // Add credential status for each provider
    const allProviders = new Set(this.providerCredentialMap.keys());
    allProviders.forEach((provider) => {
      const rotationStatus = this.credentialManager.getRotationStatus(provider);
      const credentials = this.credentialManager.getAllCredentials(provider);

      status.credentials[provider] = {
        ...rotationStatus,
        credentialDetails: credentials.map((c) => ({
          id: c.id,
          displayName: c.displayName,
          successCount: c.successCount,
          failureCount: c.failureCount,
          lastUsedAt: c.lastUsedAt,
        })),
      };
    });

    return status;
  }
}
