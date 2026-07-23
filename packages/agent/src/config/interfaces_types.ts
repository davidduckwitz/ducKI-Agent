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
}

export interface AgentRunOptions {
  stream?: boolean;
  onChunk?: (chunk: string) => void;
  onEvent?: (event: AgentRunEvent) => void;
  contextCaps?: AgentRunContextCaps;
}

export type AgentRunEventType = "plan" | "iteration" | "tool_call" | "tool_result" | "reasoning" | "decision" | "guardrail";

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
  maxIterations: number;
  timeoutMs: number;
  shellToolTimeoutMs: number;
  httpToolTimeoutMs: number;
  browserToolTimeoutMs: number;
  gitToolTimeoutMs: number;
  enableAutoMemory: boolean;
  enableReflection: boolean;
  reflectionMaxRetries: number;
  reflectionStoreMemory: boolean;
  reflectionMetaReview: boolean;
  reasonerUseToolMinConfidence: number;
  maxConsecutiveToolFailures: number;
  maxRepeatedToolCall: number;
  enableAutoSkillSelection: boolean;
  autoSkillScoreThreshold: number;
  autoSkillMarginThreshold: number;
  autoSkillMinInputLength: number;
  autoSkillMinOverlap: number;
  skillBehavior: "automatic" | "active";
  autoSkillFallbackNone: boolean;
  enabledSkillAllowlist: string[];
}