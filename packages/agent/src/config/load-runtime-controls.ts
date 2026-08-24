import type { AgentRuntimeControls } from "./interfaces_types.js";
import { createProviderSettings, type ProviderSettings } from "./provider-settings.js";

export type AgentModelProfile = "legacy" | "small" | "balanced" | "large";

type ProfileDefaults = {
  maxIterations: number;
  maxOutputTokens: number;
  timeoutMs: number;
  enableReflection: boolean;
  reflectionMaxRetries: number;
  reflectionStoreMemory: boolean;
  reflectionMetaReview: boolean;
  reflectionPostIteration: boolean;
  codingMaxIterations: number;
  codingEnableReflection: boolean;
  codingEnableVerify: boolean;
  checklistEnabled: boolean;
  checklistMaxItemAttempts: number;
  reasonerUseToolMinConfidence: number;
  maxRepeatedToolCall: number;
  staleReadLoopThreshold: number;
  selfRepairMaxAttempts: number;
};

/**
 * Model-size oriented defaults. `legacy` intentionally reproduces the effective defaults used by
 * the core Agent before model profiles were introduced, so opting into profile infrastructure does
 * not silently change an installation. Explicit AGENT_* variables always override the selected
 * profile below.
 *
 * `small` is tuned for capable 7B-14B tool-calling models (for example Qwen-class local models):
 * fewer opportunities to loop, smaller output budgets, deterministic verification enabled, and
 * generic self-reflection disabled. The run journal/checklist remain enabled as external state
 * because small models benefit more from structured state than from another free-form critique.
 */
const PROFILE_DEFAULTS: Record<AgentModelProfile, ProfileDefaults> = {
  legacy: {
    maxIterations: 50,
    maxOutputTokens: 16384,
    timeoutMs: 600000,
    enableReflection: true,
    reflectionMaxRetries: 1,
    reflectionStoreMemory: false,
    reflectionMetaReview: false,
    reflectionPostIteration: true,
    codingMaxIterations: 60,
    codingEnableReflection: false,
    codingEnableVerify: false,
    checklistEnabled: false,
    checklistMaxItemAttempts: 3,
    reasonerUseToolMinConfidence: 0.65,
    maxRepeatedToolCall: 3,
    staleReadLoopThreshold: 4,
    selfRepairMaxAttempts: 2,
  },
  small: {
    maxIterations: 18,
    maxOutputTokens: 6144,
    timeoutMs: 480000,
    enableReflection: false,
    reflectionMaxRetries: 0,
    reflectionStoreMemory: false,
    reflectionMetaReview: false,
    reflectionPostIteration: false,
    codingMaxIterations: 26,
    codingEnableReflection: false,
    codingEnableVerify: true,
    checklistEnabled: true,
    checklistMaxItemAttempts: 2,
    reasonerUseToolMinConfidence: 0.65,
    maxRepeatedToolCall: 2,
    staleReadLoopThreshold: 3,
    selfRepairMaxAttempts: 2,
  },
  balanced: {
    maxIterations: 30,
    maxOutputTokens: 8192,
    timeoutMs: 540000,
    enableReflection: false,
    reflectionMaxRetries: 1,
    reflectionStoreMemory: false,
    reflectionMetaReview: false,
    reflectionPostIteration: false,
    codingMaxIterations: 36,
    codingEnableReflection: false,
    codingEnableVerify: true,
    checklistEnabled: true,
    checklistMaxItemAttempts: 2,
    reasonerUseToolMinConfidence: 0.68,
    maxRepeatedToolCall: 2,
    staleReadLoopThreshold: 3,
    selfRepairMaxAttempts: 2,
  },
  large: {
    maxIterations: 45,
    maxOutputTokens: 12288,
    timeoutMs: 600000,
    enableReflection: true,
    reflectionMaxRetries: 1,
    reflectionStoreMemory: false,
    reflectionMetaReview: false,
    reflectionPostIteration: false,
    codingMaxIterations: 45,
    codingEnableReflection: false,
    codingEnableVerify: true,
    checklistEnabled: true,
    checklistMaxItemAttempts: 3,
    reasonerUseToolMinConfidence: 0.7,
    maxRepeatedToolCall: 3,
    staleReadLoopThreshold: 4,
    selfRepairMaxAttempts: 3,
  },
};

export function getAgentModelProfile(value = process.env["AGENT_MODEL_PROFILE"]): AgentModelProfile {
  const normalized = value?.trim().toLowerCase();
  return normalized === "small" || normalized === "balanced" || normalized === "large" || normalized === "legacy"
    ? normalized
    : "legacy";
}

function envValue(primary: string, legacyAlias?: string): string | undefined {
  const canonical = process.env[primary];
  if (canonical !== undefined) return canonical;
  return legacyAlias ? process.env[legacyAlias] : undefined;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(name: string, fallback: number, legacyAlias?: string): number {
  const raw = envValue(name, legacyAlias);
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean, legacyAlias?: string): boolean {
  const raw = envValue(name, legacyAlias);
  if (raw === undefined) return fallback;
  return raw.toLowerCase() !== "false";
}

function envBoolTrueOnly(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === "true";
}

/**
 * Load AgentRuntimeControls from environment variables and defaults.
 * Combines existing Agent settings with Provider settings. AGENT_MODEL_PROFILE supplies only
 * defaults; every specific AGENT_* variable below remains authoritative when present.
 *
 * Canonical environment keys mirror the DB-backed settings consumed by Agent.loadRuntimeControls().
 * Two historical aliases are still accepted when their canonical counterpart is absent:
 * AGENT_REASONER_MIN_CONFIDENCE and AGENT_SELF_REPAIR_ENABLED.
 */
export function loadAgentRuntimeControls(): AgentRuntimeControls {
  const providerSettings = createProviderSettings();
  const profile = PROFILE_DEFAULTS[getAgentModelProfile()];

  return {
    maxIterations: envInt("AGENT_MAX_ITERATIONS", profile.maxIterations),
    maxOutputTokens: envInt("AGENT_MAX_OUTPUT_TOKENS", profile.maxOutputTokens),
    timeoutMs: envInt("AGENT_TIMEOUT_MS", profile.timeoutMs),
    shellToolTimeoutMs: parseInt(process.env["AGENT_SHELL_TIMEOUT_MS"] ?? "30000"),
    httpToolTimeoutMs: parseInt(process.env["AGENT_HTTP_TIMEOUT_MS"] ?? "30000"),
    browserToolTimeoutMs: parseInt(process.env["AGENT_BROWSER_TIMEOUT_MS"] ?? "60000"),
    gitToolTimeoutMs: parseInt(process.env["AGENT_GIT_TIMEOUT_MS"] ?? "30000"),
    qualityPassTimeoutMs: parseInt(process.env["AGENT_QUALITY_PASS_TIMEOUT_MS"] ?? "45000"),

    enableAutoMemory: (process.env["AGENT_AUTO_MEMORY"] ?? "true").toLowerCase() !== "false",
    enableReflection: envBool("AGENT_ENABLE_REFLECTION", profile.enableReflection),
    reflectionMaxRetries: envInt("AGENT_REFLECTION_MAX_RETRIES", profile.reflectionMaxRetries),
    reflectionStoreMemory: envBool("AGENT_REFLECTION_STORE_MEMORY", profile.reflectionStoreMemory),
    reflectionMetaReview: envBool("AGENT_REFLECTION_META_REVIEW", profile.reflectionMetaReview),
    reflectionPostIteration: envBool("AGENT_REFLECTION_POST_ITERATION", profile.reflectionPostIteration),
    reflectionPostIterationMinQuality: (process.env["AGENT_REFLECTION_POST_ITERATION_MIN_QUALITY"] ?? "adequate") as "poor" | "adequate" | "good" | "excellent",

    codingMaxIterations: envInt("AGENT_CODING_MAX_ITERATIONS", profile.codingMaxIterations),
    codingEnableReflection: envBoolTrueOnly("AGENT_CODING_ENABLE_REFLECTION", profile.codingEnableReflection),
    codingEnableVerify: envBoolTrueOnly("AGENT_CODING_ENABLE_VERIFY", profile.codingEnableVerify),

    costBudgetUsd: parseFloat(process.env["AGENT_COST_BUDGET_USD"] ?? "0"),
    costGovernorStop: (process.env["AGENT_COST_GOVERNOR_STOP"] ?? "false").toLowerCase() === "true",
    autoDowngrade: (process.env["AGENT_AUTO_DOWNGRADE"] ?? "false").toLowerCase() === "true",

    lightweightMaxIterations: parseInt(process.env["AGENT_LIGHTWEIGHT_MAX_ITERATIONS"] ?? "10"),
    chatbotMaxIterations: parseInt(process.env["AGENT_CHATBOT_MAX_ITERATIONS"] ?? "5"),

    enableVerify: (process.env["AGENT_ENABLE_VERIFY"] ?? "false").toLowerCase() === "true",
    verifyMaxFixAttempts: parseInt(process.env["AGENT_VERIFY_MAX_FIX_ATTEMPTS"] ?? "1"),
    verifyDeriveConstraints: (process.env["AGENT_VERIFY_DERIVE_CONSTRAINTS"] ?? "true").toLowerCase() !== "false",

    checklistEnabled: envBoolTrueOnly("AGENT_CHECKLIST_ENABLED", profile.checklistEnabled),
    checklistMinComplexity: (["low", "medium", "high"].includes((process.env["AGENT_CHECKLIST_MIN_COMPLEXITY"] ?? "").toLowerCase())
      ? (process.env["AGENT_CHECKLIST_MIN_COMPLEXITY"] ?? "medium").toLowerCase()
      : "medium") as "low" | "medium" | "high",
    checklistMaxItemAttempts: envInt("AGENT_CHECKLIST_MAX_ITEM_ATTEMPTS", profile.checklistMaxItemAttempts),
    checklistSkippedPolicy: ((process.env["AGENT_CHECKLIST_SKIPPED_POLICY"] ?? "soft").toLowerCase() === "strict" ? "strict" : "soft") as "soft" | "strict",

    runJournalEnabled: (process.env["AGENT_RUN_JOURNAL_ENABLED"] ?? "true").toLowerCase() !== "false",

    enableVision: (process.env["AGENT_ENABLE_VISION"] ?? "true").toLowerCase() !== "false",

    reasonerUseToolMinConfidence: envFloat(
      "AGENT_REASONER_USE_TOOL_MIN_CONFIDENCE",
      profile.reasonerUseToolMinConfidence,
      "AGENT_REASONER_MIN_CONFIDENCE"
    ),
    maxConsecutiveToolFailures: parseInt(process.env["AGENT_MAX_TOOL_FAILURES"] ?? "3"),
    maxRepeatedToolCall: envInt("AGENT_MAX_REPEATED_TOOL_CALL", profile.maxRepeatedToolCall),
    staleReadLoopThreshold: envInt("AGENT_STALE_READ_STREAK", profile.staleReadLoopThreshold),

    selfRepairEnabled: envBool("AGENT_SELF_REPAIR", true, "AGENT_SELF_REPAIR_ENABLED"),
    selfRepairMaxAttempts: envInt("AGENT_SELF_REPAIR_MAX_ATTEMPTS", profile.selfRepairMaxAttempts),

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

    browserReuseSession: (process.env["BROWSER_REUSE_SESSION"] ?? "true").toLowerCase() !== "false",
    browserHeadless: (process.env["BROWSER_HEADLESS_MODE"] ?? "true").toLowerCase() !== "false",
    browserViewportWidth: parseInt(process.env["BROWSER_VIEWPORT_WIDTH"] ?? "1440", 10) || 1440,
    browserViewportHeight: parseInt(process.env["BROWSER_VIEWPORT_HEIGHT"] ?? "1024", 10) || 1024,
    browserExecutablePath: process.env["BROWSER_CUSTOM_EXECUTABLE_PATH"] ?? "",
    browserUserAgent: process.env["BROWSER_USER_AGENT"] ?? "",
    browserScreenshotFormat: (process.env["BROWSER_SCREENSHOT_FORMAT"] ?? "jpeg") as "jpeg" | "png" | "webp",
    browserScreenshotQuality: parseInt(process.env["BROWSER_SCREENSHOT_QUALITY"] ?? "85", 10) || 85,
    browserDisableImages: (process.env["BROWSER_DISABLE_IMAGES"] ?? "false").toLowerCase() === "true",
    browserBlockResources: (process.env["BROWSER_BLOCK_RESOURCES"] ?? "tracking") as "none" | "tracking" | "ads" | "all",
    browserHideAutomation: (process.env["BROWSER_DISABLE_AUTOMATION"] ?? "true").toLowerCase() !== "false",
    browserCookieDetection: (process.env["BROWSER_COOKIE_DETECTION"] ?? "false").toLowerCase() === "true",
    browserProxyUrl: process.env["BROWSER_PROXY_URL"] ?? "",
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
