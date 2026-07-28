
export interface AgentOptions {
  name?: string;
  systemPrompt?: string;
  maxIterations?: number;
  timeoutMs?: number;
  enableReflection?: boolean;
  enablePlanning?: boolean;
  enableAutoMemory?: boolean;
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
}

export type AgentRunEventType = "plan" | "iteration" | "tool_call" | "tool_result" | "reasoning" | "decision" | "guardrail" | "mode_selected" | "browser_preview";

export interface AgentRunEvent {
  type: AgentRunEventType;
  message: string;
  data?: Record<string, unknown>;
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
  enableReflection: boolean;
  reflectionMaxRetries: number;
  reflectionStoreMemory: boolean;
  reflectionMetaReview: boolean;

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
}

// Event Emitter for Agent lifecycle events (chunk streaming, state updates)
export interface AgentRunEventEmitter {
  emitChunk(chunk: string): void;
  emitEvent(event: AgentRunEvent): void;
}

export type AgentEventEmitter = AgentRunEventEmitter;
