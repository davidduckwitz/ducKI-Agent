import { z } from "zod";

/**
 * Adapter Configuration - Shared between Agent and Providers
 * No dependencies on @ducki/agent to avoid circular imports
 */

export const AdapterConfigSchema = z.object({
  // Timeouts
  timeoutMs: z.number().min(5000).max(600000).default(30000),
  streamTimeoutMs: z.number().min(5000).max(600000).default(60000),

  // Retries
  maxRetries: z.number().min(0).max(10).default(3),
  backoffStrategy: z.enum(["exponential", "linear", "fixed"]).default("exponential"),

  // Model-Specific
  enableExtendedThinking: z.boolean().default(false),
  maxTokensOverride: z.number().optional(),
  temperatureDefault: z.number().min(0).max(2).default(1),

  // Features
  enableStreaming: z.boolean().default(true),
  enableVision: z.boolean().default(false),

  // Logging
  logRequests: z.boolean().default(false),
  logResponses: z.boolean().default(false),
});

export type AdapterConfig = z.infer<typeof AdapterConfigSchema>;

/**
 * Provider Router Configuration
 */
export const ProviderRouterConfigSchema = z.object({
  // Health Tracking
  maxErrorsPerProvider: z.number().min(1).max(100).default(5),
  errorResetWindow: z.number().min(60000).max(3600000).default(5 * 60 * 1000),

  // Health Check
  healthCheckInterval: z.number().min(1000).max(300000).default(30000),
  healthCheckEnabled: z.boolean().default(true),

  // Failover
  failoverEnabled: z.boolean().default(true),
  failoverStrategy: z.enum(["intelligent", "round-robin", "random"]).default("intelligent"),
  failoverLogging: z.boolean().default(true),

  // Provider Priority
  providerPriorities: z.record(z.string(), z.number().min(0).max(100)).default({
    anthropic: 100,
    gemini: 80,
    bedrock: 60,
  }),
});

export type ProviderRouterConfig = z.infer<typeof ProviderRouterConfigSchema>;
