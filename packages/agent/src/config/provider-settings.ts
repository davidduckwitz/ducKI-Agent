import { z } from "zod";
import type { AdapterConfig, ProviderRouterConfig } from "@ducki/providers";

/**
 * Provider Settings - Konfiguration für Multi-Provider LLM System
 *
 * Unterstützt:
 * - Environment Variable Overrides
 * - Runtime Configuration
 * - Database Persistence
 */

// ============================================================
// ZONE: Error Classifier Settings
// ============================================================

export const ErrorClassifierConfigSchema = z.object({
  // Retry Behavior
  retryableErrorCategories: z.array(z.string()).default([
    "RateLimited",
    "TimeoutError",
    "NetworkError",
    "ProviderDown",
    "TransientError",
    "ContextWindowExceeded",
    "Timeout",
  ]),
  maxRetryAttempts: z.number().min(1).max(10).default(3),
  retryBackoffMs: z.number().min(100).max(30000).default(1000),
  retryBackoffMultiplier: z.number().min(1).max(5).default(2),

  // Compression
  shouldCompressionThreshold: z.number().min(50).max(99).default(80),
  autoCompressOnError: z.boolean().default(true),
  compressionMinChars: z.number().min(1000).default(50000),

  // Credential Rotation
  rotationStrategy: z.enum(["auto", "manual"]).default("auto"),
  maxErrorsBeforeRotation: z.number().min(1).max(100).default(5),

  // Fallback
  enableFallback: z.boolean().default(true),
  fallbackStrategy: z.enum(["primary-first", "round-robin"]).default("primary-first"),

  // Logging
  logClassifications: z.boolean().default(false),
  logRetries: z.boolean().default(true),
});

export type ErrorClassifierConfig = z.infer<typeof ErrorClassifierConfigSchema>;

// Note: ProviderRouterConfig and AdapterConfig are imported from @ducki/providers
// to avoid circular dependencies

// ============================================================
// ZONE: Provider-Specific Configs
// ============================================================

const BaseAdapterConfig = z.object({
  timeoutMs: z.number().default(30000),
  streamTimeoutMs: z.number().default(60000),
  maxRetries: z.number().default(3),
  backoffStrategy: z.enum(["exponential", "linear", "fixed"]).default("exponential"),
  enableExtendedThinking: z.boolean().default(false),
  maxTokensOverride: z.number().optional(),
  temperatureDefault: z.number().default(1),
  enableStreaming: z.boolean().default(true),
  enableVision: z.boolean().default(false),
  logRequests: z.boolean().default(false),
  logResponses: z.boolean().default(false),
});

export type AnthropicConfig = {
  apiKeyRotationEnabled?: boolean;
  prefixCacheEnabled?: boolean;
  thinkingBudgetTokens?: number;
  [key: string]: unknown;
};

export type GeminiConfig = {
  safetyThreshold?: "BLOCK_NONE" | "BLOCK_LOW" | "BLOCK_MED" | "BLOCK_HIGH";
  generationQuality?: "draft" | "standard" | "high";
  [key: string]: unknown;
};

export type BedrockConfig = {
  region?: string;
  credentialRefreshIntervalMs?: number;
  [key: string]: unknown;
};

// ============================================================
// ZONE: Complete Provider Settings
// ============================================================

export const ProviderSettingsSchema = z.object({
  errorClassifier: z.any().optional(), // ErrorClassifierConfig from this file
  providerRouter: z.any().optional(), // ProviderRouterConfig from providers

  // Per-Provider Configs
  adapters: z.object({
    anthropic: z.any().optional(),
    gemini: z.any().optional(),
    bedrock: z.any().optional(),
  }).optional(),

  // Global Flags
  enableProviderFallback: z.boolean().default(true),
  enableAutoRetry: z.boolean().default(true),
  enableCompression: z.boolean().default(true),
  debugMode: z.boolean().default(false),
});

export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

// ============================================================
// ZONE: Environment Variable Loading
// ============================================================

/**
 * Load provider settings from environment variables
 * Follows pattern: AGENT_PROVIDER_<COMPONENT>_<SETTING>=value
 */
export function loadProviderSettingsFromEnv(): Partial<ProviderSettings> {
  return {
    errorClassifier: {
      maxRetryAttempts: parseInt(process.env["AGENT_PROVIDER_ERROR_MAX_RETRIES"] ?? "3"),
      retryBackoffMs: parseInt(process.env["AGENT_PROVIDER_ERROR_RETRY_BACKOFF_MS"] ?? "1000"),
      shouldCompressionThreshold: parseInt(process.env["AGENT_PROVIDER_ERROR_COMPRESSION_THRESHOLD"] ?? "80"),
      autoCompressOnError: (process.env["AGENT_PROVIDER_ERROR_AUTO_COMPRESS"] ?? "true").toLowerCase() !== "false",
      enableFallback: (process.env["AGENT_PROVIDER_FALLBACK_ENABLED"] ?? "true").toLowerCase() !== "false",
      logClassifications: (process.env["AGENT_PROVIDER_ERROR_LOG_CLASSIFICATIONS"] ?? "false").toLowerCase() !== "false",
      logRetries: (process.env["AGENT_PROVIDER_ERROR_LOG_RETRIES"] ?? "true").toLowerCase() !== "false",
    },

    providerRouter: {
      maxErrorsPerProvider: parseInt(process.env["AGENT_PROVIDER_MAX_ERRORS"] ?? "5"),
      errorResetWindow: parseInt(process.env["AGENT_PROVIDER_ERROR_RESET_WINDOW"] ?? String(5 * 60 * 1000)),
      healthCheckInterval: parseInt(process.env["AGENT_PROVIDER_HEALTH_CHECK_INTERVAL"] ?? "30000"),
      healthCheckEnabled: (process.env["AGENT_PROVIDER_HEALTH_CHECK_ENABLED"] ?? "true").toLowerCase() !== "false",
      failoverEnabled: (process.env["AGENT_PROVIDER_FAILOVER_ENABLED"] ?? "true").toLowerCase() !== "false",
      failoverStrategy: (process.env["AGENT_PROVIDER_FAILOVER_STRATEGY"] ?? "intelligent") as "intelligent" | "round-robin" | "random",
      failoverLogging: (process.env["AGENT_PROVIDER_FAILOVER_LOGGING"] ?? "true").toLowerCase() !== "false",
    },

    adapters: {
      anthropic: {
        timeoutMs: parseInt(process.env["AGENT_ANTHROPIC_TIMEOUT_MS"] ?? "30000"),
        streamTimeoutMs: parseInt(process.env["AGENT_ANTHROPIC_STREAM_TIMEOUT_MS"] ?? "60000"),
        maxRetries: parseInt(process.env["AGENT_ANTHROPIC_MAX_RETRIES"] ?? "3"),
        enableExtendedThinking: (process.env["AGENT_ANTHROPIC_EXTENDED_THINKING"] ?? "false").toLowerCase() !== "false",
        enableStreaming: (process.env["AGENT_ANTHROPIC_STREAMING"] ?? "true").toLowerCase() !== "false",
        apiKeyRotationEnabled: (process.env["AGENT_ANTHROPIC_KEY_ROTATION"] ?? "true").toLowerCase() !== "false",
        thinkingBudgetTokens: parseInt(process.env["AGENT_ANTHROPIC_THINKING_BUDGET"] ?? "5000"),
      },

      gemini: {
        timeoutMs: parseInt(process.env["AGENT_GEMINI_TIMEOUT_MS"] ?? "30000"),
        maxRetries: parseInt(process.env["AGENT_GEMINI_MAX_RETRIES"] ?? "3"),
        safetyThreshold: (process.env["AGENT_GEMINI_SAFETY_THRESHOLD"] ?? "BLOCK_NONE") as "BLOCK_NONE" | "BLOCK_LOW" | "BLOCK_MED" | "BLOCK_HIGH",
      },

      bedrock: {
        timeoutMs: parseInt(process.env["AGENT_BEDROCK_TIMEOUT_MS"] ?? "30000"),
        maxRetries: parseInt(process.env["AGENT_BEDROCK_MAX_RETRIES"] ?? "3"),
        region: process.env["AGENT_BEDROCK_REGION"] ?? "us-east-1",
      },
    },

    enableProviderFallback: (process.env["AGENT_PROVIDER_FALLBACK_ENABLED"] ?? "true").toLowerCase() !== "false",
    enableAutoRetry: (process.env["AGENT_AUTO_RETRY"] ?? "true").toLowerCase() !== "false",
    enableCompression: (process.env["AGENT_COMPRESSION_ENABLED"] ?? "true").toLowerCase() !== "false",
    debugMode: (process.env["AGENT_PROVIDER_DEBUG"] ?? "false").toLowerCase() !== "false",
  };
}

/**
 * Create default settings with env var overrides
 */
export function createProviderSettings(overrides?: Partial<ProviderSettings>): ProviderSettings {
  const envSettings = loadProviderSettingsFromEnv();
  const merged = {
    ...ProviderSettingsSchema.parse({}),
    ...envSettings,
    ...overrides,
  };
  return ProviderSettingsSchema.parse(merged);
}
