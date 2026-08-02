import type { AgentHook } from "../hooks/agent-hooks.js";
import type {
  AgentRunEventSnapshot,
  AgentEventEmitter as AgentEventEmitterV2,
  AgentRunEventType
} from "../events/agent-events.js";

// Re-export granular event types
export type { AgentRunEventSnapshot, AgentEventEmitterV2, AgentRunEventType };

export interface AgentOptions {
  name?: string;
  systemPrompt?: string;
  maxIterations?: number;
  timeoutMs?: number;
  enableReflection?: boolean;
  enablePlanning?: boolean;
  enableAutoMemory?: boolean;
  /** Hooks for intercepting agent lifecycle events (Phase 1) */
  hooks?: AgentHook[];
}

export type AgentStatus = "idle" | "running" | "paused" | "error" | "stopped";

export interface AgentRunResult {
  response: string;
  iterations: number;
  toolsUsed: string[];
  conversationId?: number;
}

export interface AgentRunContextCaps {
  maxSystemPromptChars?: number;
  maxDynamicMemoryChars?: number;
  maxContextMessages?: number;
  maxContextChars?: number;
  maxContextMessageChars?: number;
  supportsImageInput?: boolean;
  supportsScreenshots?: boolean;
  maxImageSize?: number;
}

export interface AgentRunAttachment {
  name: string;
  path?: string;
  url?: string;
  mimeType?: string;
}

export interface AgentRunOptions {
  stream?: boolean;
  onChunk?: (chunk: string) => void;
  onEvent?: (event: AgentRunEvent) => void;
  contextCaps?: AgentRunContextCaps;
  /** "plan" short-circuits the run loop entirely: it only produces a structured plan
   *  via the Planner and returns it as the response, without executing any tools. */
  agentMode?: "full" | "lightweight" | "chatbot" | "plan";
  attachments?: AgentRunAttachment[];
  /** Client-side UUID for message deduplication */
  localMessageId?: string;
}

export interface AgentRunEvent {
  type: AgentRunEventType; // Includes all old and new event types
  message: string;
  data?: Record<string, unknown>;
  snapshot?: any; // AgentRunEventSnapshot, made optional for backward compat
  timestamp: string;
}

export interface SkillManifest {
  slug: string;
  name: string;
  description?: string;
  path: string;
  primarySkills: string[];
  relatedSkills: string[];
  fallbackSkills: string[];
  // Hermes Pattern #1: Skill Metadata System
  category?: string;
  tags?: string[];
  scripts?: Record<string, string>;
  dependencies?: string[];
  priority?: "critical" | "high" | "medium" | "low";
}

export interface SkillSummary extends SkillManifest {
  content: string;
}

export interface SkillScore {
  skill: SkillManifest;
  score: number;
  overlap: number;
}

export interface AgentRuntimeControls {
  // Execution
  maxIterations: number;
  timeoutMs: number;
  shellToolTimeoutMs: number;
  httpToolTimeoutMs: number;
  browserToolTimeoutMs: number;
  gitToolTimeoutMs: number;

  // Memory & Reflection
  enableAutoMemory: boolean;
  /**
   * Enable response quality evaluation and self-improvement.
   * When enabled, agent evaluates final response quality and attempts improvements.
   * - Full mode: enabled by default, allows reflectionMaxRetries improvement cycles
   * - Lightweight mode: disabled (only 5 iterations available, reflection would consume ~20%)
   * - Chatbot mode: disabled (only 1-5 iterations total, no room for reflection)
   * Cost: ~200-500 tokens per reflection + ~200-400ms latency
   * Recommended: true for full mode (improves response quality)
   * Settings key: AGENT_ENABLE_REFLECTION
   */
  enableReflection: boolean;
  /**
   * Maximum reflection improvement attempts per response (0-3).
   * Each attempt: evaluate quality, identify issues, generate improved version.
   * - 0: reflection disabled (quick response)
   * - 1: one improvement attempt (recommended, good quality/speed tradeoff)
   * - 2-3: multiple attempts (higher quality, slower, more tokens)
   * Note: Disabled in lightweight/chatbot modes regardless of this setting.
   * Settings key: AGENT_REFLECTION_MAX_RETRIES
   */
  reflectionMaxRetries: number;
  /**
   * Store reflection learnings (quality issues, improvement suggestions) in long-term memory.
   * Helps agent learn from its own self-evaluations over time.
   * Stores as "pending" memory entries requiring manual review before use.
   * Recommended: false (only enable if you want to review reflection learnings)
   * Settings key: AGENT_REFLECTION_STORE_MEMORY
   */
  reflectionStoreMemory: boolean;
  /**
   * Run secondary "meta-review" reflection after improvements.
   * Second reflection validates the already-improved response and catches edge cases.
   * Useful for complex responses where initial reflection might miss something.
   * Cost: +1 LLM call (~200-500 tokens) if enabled
   * Only runs if enableReflection=true and response passes first reflection.
   * Recommended: false (use for critical responses needing high confidence)
   * Settings key: AGENT_REFLECTION_META_REVIEW
   */
  reflectionMetaReview: boolean;
  /**
   * Run quality assessment after normal run completes (post maxIterations).
   * Even when run ends due to iteration limits, reflection can assess quality for learning.
   * Response is NOT improved (too late), but issues are stored in memory for future learning.
   * Cost: +1 LLM call (~200-500 tokens) only at end of run
   * Recommended: true (helps agent learn from its boundaries)
   * Settings key: AGENT_REFLECTION_POST_ITERATION
   */
  reflectionPostIteration: boolean;
  /**
   * Minimum quality threshold for storing post-iteration learnings.
   * Only stores issues in memory if quality is <= this level.
   * Values: "poor" | "adequate" | "good" | "excellent"
   * - "poor": Store if any quality issue found (most learning)
   * - "adequate": Store if quality <= adequate (most relevant)
   * - "good": Store if quality <= good (only bad responses)
   * Recommended: "adequate" (good balance of learning frequency)
   * Settings key: AGENT_REFLECTION_POST_ITERATION_MIN_QUALITY
   */
  reflectionPostIterationMinQuality: "poor" | "adequate" | "good" | "excellent";

  // Reasoning & Tools
  reasonerUseToolMinConfidence: number;
  maxConsecutiveToolFailures: number;
  maxRepeatedToolCall: number;

  // Self-Repair
  selfRepairEnabled: boolean;
  selfRepairMaxAttempts: number;

  // Skills
  enableAutoSkillSelection: boolean;
  autoSkillScoreThreshold: number;
  autoSkillMarginThreshold: number;
  autoSkillMinInputLength: number;
  autoSkillMinOverlap: number;
  skillBehavior: "automatic" | "active";
  autoSkillFallbackNone: boolean;
  enabledSkillAllowlist: string[];
  enabledOptionalTools: string[];
  alwaysLoadSkills?: string[];

  // ============================================================
  // PROVIDER SETTINGS (NEW)
  // ============================================================

  // Error Handling
  providerErrorRetryPolicy: "auto" | "manual";
  providerErrorMaxRetries: number;
  providerErrorRetryBackoffMs: number;
  providerErrorRetryBackoffMultiplier: number;

  // Compression
  providerCompressionThreshold: number; // % of max context
  providerAutoCompressOnError: boolean;
  providerCompressionMinChars: number;

  // Credential Rotation
  providerCredentialRotationStrategy: "auto" | "manual";
  providerMaxErrorsBeforeRotation: number;

  // Failover
  providerFailoverEnabled: boolean;
  providerFailoverStrategy: "intelligent" | "round-robin" | "random";
  providerMaxErrorsPerProvider: number;
  providerErrorResetWindowMs: number;

  // Logging
  providerLogClassifications: boolean;
  providerLogRetries: boolean;
  providerLogFailovers: boolean;
  providerDebugMode: boolean;

  // Adapter-Specific
  anthropicTimeoutMs: number;
  anthropicMaxRetries: number;
  anthropicExtendedThinkingEnabled: boolean;
  anthropicStreamingEnabled: boolean;

  geminiTimeoutMs: number;
  geminiMaxRetries: number;
  geminiSafetyThreshold: "BLOCK_NONE" | "BLOCK_LOW" | "BLOCK_MED" | "BLOCK_HIGH";

  bedrockTimeoutMs: number;
  bedrockMaxRetries: number;
  bedrockRegion: string;

  // Browser tool - applied as defaults on action=launch when the LLM/UI call omits them.
  /** Settings key: BROWSER_REUSE_SESSION - reuse the shared session instead of launching a new browser every run. */
  browserReuseSession: boolean;
  /** Settings key: BROWSER_HEADLESS_MODE */
  browserHeadless: boolean;
  /** Settings key: BROWSER_VIEWPORT_WIDTH */
  browserViewportWidth: number;
  /** Settings key: BROWSER_VIEWPORT_HEIGHT */
  browserViewportHeight: number;
  /** Settings key: BROWSER_CUSTOM_EXECUTABLE_PATH */
  browserExecutablePath: string;
  /** Settings key: BROWSER_USER_AGENT */
  browserUserAgent: string;
  /** Settings key: BROWSER_SCREENSHOT_FORMAT - jpeg is the safest default (many local vision models can't decode webp). */
  browserScreenshotFormat: "jpeg" | "png" | "webp";
  /** Settings key: BROWSER_SCREENSHOT_QUALITY */
  browserScreenshotQuality: number;
  /** Settings key: BROWSER_DISABLE_IMAGES */
  browserDisableImages: boolean;
  /** Settings key: BROWSER_BLOCK_RESOURCES */
  browserBlockResources: "none" | "tracking" | "ads" | "all";
  /** Settings key: BROWSER_DISABLE_AUTOMATION - inverted: true keeps automation hidden. */
  browserHideAutomation: boolean;
  /** Settings key: BROWSER_COOKIE_DETECTION */
  browserCookieDetection: boolean;
  /** Settings key: BROWSER_PROXY_URL */
  browserProxyUrl: string;
}

// Event Emitter for Agent lifecycle events (chunk streaming, state updates)
export interface AgentRunEventEmitter {
  emitChunk(chunk: string): void;
  emitEvent(event: AgentRunEvent): void;
}

export type AgentEventEmitter = AgentRunEventEmitter;
