import type { AgentRuntimeControls } from "./interfaces_types.js";
import { createProviderSettings, type ProviderSettings } from "./provider-settings.js";

/**
 * Load AgentRuntimeControls from environment variables and defaults
 * Combines existing Agent settings with new Provider settings
 */
export function loadAgentRuntimeControls(): AgentRuntimeControls {
  const providerSettings = createProviderSettings();

  return {
    // Existing settings (from Agent.ts pattern)
    maxIterations: parseInt(process.env["AGENT_MAX_ITERATIONS"] ?? "50"),
    timeoutMs: parseInt(process.env["AGENT_TIMEOUT_MS"] ?? "600000"),
    shellToolTimeoutMs: parseInt(process.env["AGENT_SHELL_TIMEOUT_MS"] ?? "30000"),
    httpToolTimeoutMs: parseInt(process.env["AGENT_HTTP_TIMEOUT_MS"] ?? "30000"),
    browserToolTimeoutMs: parseInt(process.env["AGENT_BROWSER_TIMEOUT_MS"] ?? "60000"),
    gitToolTimeoutMs: parseInt(process.env["AGENT_GIT_TIMEOUT_MS"] ?? "30000"),

    enableAutoMemory: (process.env["AGENT_AUTO_MEMORY"] ?? "true").toLowerCase() !== "false",
    enableReflection: (process.env["AGENT_ENABLE_REFLECTION"] ?? "true").toLowerCase() !== "false",
    reflectionMaxRetries: parseInt(process.env["AGENT_REFLECTION_MAX_RETRIES"] ?? "3"),
    reflectionStoreMemory: (process.env["AGENT_REFLECTION_STORE_MEMORY"] ?? "true").toLowerCase() !== "false",
    reflectionMetaReview: (process.env["AGENT_REFLECTION_META_REVIEW"] ?? "true").toLowerCase() !== "false",
    reflectionPostIteration: (process.env["AGENT_REFLECTION_POST_ITERATION"] ?? "true").toLowerCase() !== "false",
    reflectionPostIterationMinQuality: (process.env["AGENT_REFLECTION_POST_ITERATION_MIN_QUALITY"] ?? "adequate") as "poor" | "adequate" | "good" | "excellent",

    reasonerUseToolMinConfidence: parseFloat(process.env["AGENT_REASONER_MIN_CONFIDENCE"] ?? "0.7"),
    maxConsecutiveToolFailures: parseInt(process.env["AGENT_MAX_TOOL_FAILURES"] ?? "3"),
    maxRepeatedToolCall: parseInt(process.env["AGENT_MAX_REPEATED_TOOL_CALL"] ?? "3"),

    selfRepairEnabled: (process.env["AGENT_SELF_REPAIR_ENABLED"] ?? "true").toLowerCase() !== "false",
    selfRepairMaxAttempts: parseInt(process.env["AGENT_SELF_REPAIR_MAX_ATTEMPTS"] ?? "3"),

    enableAutoSkillSelection: (process.env["AGENT_AUTO_SKILL_SELECTION"] ?? "true").toLowerCase() !== "false",
    autoSkillScoreThreshold: parseFloat(process.env["AGENT_AUTO_SKILL_THRESHOLD"] ?? "0.78"),
    autoSkillMarginThreshold: parseFloat(process.env["AGENT_AUTO_SKILL_MARGIN"] ?? "0.2"),
    autoSkillMinInputLength: parseInt(process.env["AGENT_AUTO_SKILL_MIN_INPUT_LEN"] ?? "20"),
    autoSkillMinOverlap: parseInt(process.env["AGENT_AUTO_SKILL_MIN_OVERLAP"] ?? "2"),
    skillBehavior: (process.env["AGENT_SKILL_BEHAVIOR"] ?? "automatic") as "automatic" | "active",
    autoSkillFallbackNone: (process.env["AGENT_AUTO_SKILL_FALLBACK_NONE"] ?? "false").toLowerCase() !== "false",
    enabledSkillAllowlist: (process.env["AGENT_ENABLED_SKILL_ALLOWLIST"] ?? "").split(",").filter(Boolean),
    enabledOptionalTools: (process.env["AGENT_ENABLED_OPTIONAL_TOOLS"] ?? "").split(",").filter(Boolean),
    alwaysLoadSkills: (process.env["AGENT_ALWAYS_LOAD_SKILLS"] ?? "").split(",").filter(Boolean),

    // Provider Settings (NEW)
    providerErrorRetryPolicy: (process.env["AGENT_PROVIDER_ERROR_RETRY_POLICY"] ?? "auto") as "auto" | "manual",
    providerErrorMaxRetries: providerSettings.errorClassifier?.maxRetryAttempts ?? 3,
    providerErrorRetryBackoffMs: providerSettings.errorClassifier?.retryBackoffMs ?? 1000,
    providerErrorRetryBackoffMultiplier: providerSettings.errorClassifier?.retryBackoffMultiplier ?? 2,

    providerCompressionThreshold: providerSettings.errorClassifier?.shouldCompressionThreshold ?? 80,
    providerAutoCompressOnError: providerSettings.errorClassifier?.autoCompressOnError ?? true,
    providerCompressionMinChars: providerSettings.errorClassifier?.compressionMinChars ?? 50000,

    providerCredentialRotationStrategy: providerSettings.errorClassifier?.rotationStrategy ?? "auto",
    providerMaxErrorsBeforeRotation: providerSettings.errorClassifier?.maxErrorsBeforeRotation ?? 5,

    providerFailoverEnabled: (providerSettings.providerRouter as any)?.failoverEnabled ?? true,
    providerFailoverStrategy: (providerSettings.providerRouter as any)?.failoverStrategy ?? "intelligent",
    providerMaxErrorsPerProvider: (providerSettings.providerRouter as any)?.maxErrorsPerProvider ?? 5,
    providerErrorResetWindowMs: (providerSettings.providerRouter as any)?.errorResetWindow ?? 5 * 60 * 1000,

    providerLogClassifications: (providerSettings.errorClassifier as any)?.logClassifications ?? false,
    providerLogRetries: (providerSettings.errorClassifier as any)?.logRetries ?? true,
    providerLogFailovers: (providerSettings.providerRouter as any)?.failoverLogging ?? true,
    providerDebugMode: providerSettings.debugMode ?? false,

    // Adapter-Specific
    anthropicTimeoutMs: providerSettings.adapters?.anthropic?.timeoutMs ?? 30000,
    anthropicMaxRetries: providerSettings.adapters?.anthropic?.maxRetries ?? 3,
    anthropicExtendedThinkingEnabled: providerSettings.adapters?.anthropic?.enableExtendedThinking ?? false,
    anthropicStreamingEnabled: providerSettings.adapters?.anthropic?.enableStreaming ?? true,

    geminiTimeoutMs: providerSettings.adapters?.gemini?.timeoutMs ?? 30000,
    geminiMaxRetries: providerSettings.adapters?.gemini?.maxRetries ?? 3,
    geminiSafetyThreshold: providerSettings.adapters?.gemini?.safetyThreshold ?? "BLOCK_NONE",

    bedrockTimeoutMs: providerSettings.adapters?.bedrock?.timeoutMs ?? 30000,
    bedrockMaxRetries: providerSettings.adapters?.bedrock?.maxRetries ?? 3,
    bedrockRegion: providerSettings.adapters?.bedrock?.region ?? "us-east-1",
  };
}

/**
 * Create a partial AgentRuntimeControls from a ProviderSettings object
 * Useful for applying configuration changes at runtime
 */
export function providerSettingsToRuntimeControls(
  settings: ProviderSettings,
  current: AgentRuntimeControls
): AgentRuntimeControls {
  return {
    ...current,
    providerErrorMaxRetries: settings.errorClassifier?.maxRetryAttempts ?? current.providerErrorMaxRetries,
    providerErrorRetryBackoffMs: settings.errorClassifier?.retryBackoffMs ?? current.providerErrorRetryBackoffMs,
    providerErrorRetryBackoffMultiplier:
      settings.errorClassifier?.retryBackoffMultiplier ?? current.providerErrorRetryBackoffMultiplier,
    providerCompressionThreshold:
      settings.errorClassifier?.shouldCompressionThreshold ?? current.providerCompressionThreshold,
    providerAutoCompressOnError: settings.errorClassifier?.autoCompressOnError ?? current.providerAutoCompressOnError,
    providerCompressionMinChars: settings.errorClassifier?.compressionMinChars ?? current.providerCompressionMinChars,
    providerMaxErrorsBeforeRotation:
      settings.errorClassifier?.maxErrorsBeforeRotation ?? current.providerMaxErrorsBeforeRotation,
    providerFailoverEnabled: settings.providerRouter?.failoverEnabled ?? current.providerFailoverEnabled,
    providerFailoverStrategy: settings.providerRouter?.failoverStrategy ?? current.providerFailoverStrategy,
    providerMaxErrorsPerProvider: settings.providerRouter?.maxErrorsPerProvider ?? current.providerMaxErrorsPerProvider,
    providerErrorResetWindowMs: settings.providerRouter?.errorResetWindow ?? current.providerErrorResetWindowMs,
    providerLogClassifications: settings.errorClassifier?.logClassifications ?? current.providerLogClassifications,
    providerLogRetries: settings.errorClassifier?.logRetries ?? current.providerLogRetries,
    providerLogFailovers: settings.providerRouter?.failoverLogging ?? current.providerLogFailovers,
    providerDebugMode: settings.debugMode ?? current.providerDebugMode,
  };
}
