import { z } from "zod";
import { resolve, sep } from "node:path";

export {
  foldGerman,
  tokenizeText,
  extractKeywords,
  scoreKeywordRelevance,
  buildMatchSnippet,
  type TokenizeOptions,
} from "./text-search.js";

// ============================================================
// Agent Types
// ============================================================

export const AgentStatusSchema = z.enum(["idle", "running", "paused", "error", "stopped"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export type LLMContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
  | { type: "image_data"; image_data: { url: string; mime_type: string } };

export interface LLMMessage {
  role: MessageRole;
  content: string | LLMContent[];
  toolCallId?: string;
  toolCalls?: ToolCall[];
  metadata?: string | Record<string, unknown>;
  /**
   * Marks this message as the end of a cacheable prompt prefix. Providers that support
   * explicit prompt caching (Anthropic, and Anthropic models via OpenRouter) attach a
   * cache breakpoint here; everything from the start of the request up to and including
   * this message is then billed at the cached rate on subsequent calls.
   *
   * Only set it on content that is IDENTICAL across the calls of a run - a static system
   * prompt and the tool definitions. A breakpoint on text that changes every iteration
   * invalidates the cache on every iteration and costs more than it saves.
   */
  cacheControl?: "ephemeral";
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMResponse {
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** True when the server reported no usage and the counts were derived from the text
     *  instead. Local OpenAI-compatible servers frequently omit usage on the streaming
     *  path; an approximation is more useful than zeros, but must not be presented as a
     *  measured value. */
    estimated?: boolean;
    /** Input tokens served from the prompt cache (billed at a fraction of the normal rate). */
    cachedInputTokens?: number;
    /** Input tokens written INTO the cache by this call (billed at a premium, once). */
    cacheWriteTokens?: number;
  };
  model?: string;
  finishReason?: string;
}

/**
 * finish_reason for a stream that died after delivering part of its output.
 *
 * Not a provider value - the providers synthesise it so a caller can tell "the model stopped
 * here on purpose" from "the connection dropped mid-sentence". Both mean the payload is
 * incomplete, which is what callers act on.
 */
export const INCOMPLETE_STREAM_FINISH_REASON = "incomplete_stream";

/** True when a response is known to be cut short - by the output cap or by a broken stream. */
export function isIncompleteResponse(finishReason: string | undefined): boolean {
  return finishReason === "length" || finishReason === INCOMPLETE_STREAM_FINISH_REASON;
}

/**
 * True when a response's completion-token count sits close enough to the requested output cap
 * that it was very likely cut off, REGARDLESS of what finish_reason the backend reported.
 *
 * `isIncompleteResponse` trusts the provider to say so honestly - many local/OpenAI-compatible
 * backends report "stop" even when they hit the token limit mid-generation, because their
 * server-side cap silently overrides the requested one. Aider hit the same gap and added the
 * same style of guard: a response landing at ~92%+ of the requested cap is treated as truncated
 * even on a clean finish_reason, because a model that finished on its own almost never stops
 * exactly at the wall - it stops mid-sentence when the wall stops it.
 *
 * Deliberately conservative in the other direction too: `outputTokens` is sometimes an
 * ESTIMATE (chars/4) rather than a true provider count, so the threshold stays high (92%) to
 * keep false positives rare - a false positive here only costs a retry prompt, never data loss,
 * so erring toward "ask again" is the safe side of this trade-off.
 */
export function isLikelyTruncatedByLength(
  outputTokens: number | undefined,
  maxOutputTokens: number | undefined,
  thresholdRatio = 0.92
): boolean {
  if (!outputTokens || !maxOutputTokens || maxOutputTokens <= 0) return false;
  return outputTokens >= maxOutputTokens * thresholdRatio;
}

export interface GenerateOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  stream?: boolean;
  /** Aborts the in-flight LLM request (e.g. user clicked Stop, or the run timed out).
   *  Providers that support it forward this to their underlying HTTP client so the
   *  request is actually cancelled instead of running to completion unseen. */
  signal?: AbortSignal;
}

// ============================================================
// Tool Types
// ============================================================

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ToolDisposition = "success" | "error" | "timeout" | "unknown";

export interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
  disposition?: ToolDisposition;
  metadata?: {
    toolName: string;
    executionTime: number;
  };
}

export interface ToolExecutor {
  name: string;
  description: string;
  definition: ToolDefinition;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

// ============================================================
// Task Types
// ============================================================

export const TaskStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskPrioritySchema = z.enum(["low", "medium", "high", "critical"]);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export interface Task {
  id: number;
  projectId?: number;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  subtasks?: SubTask[];
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubTask {
  id: string;
  title: string;
  status: TaskStatus;
  result?: string;
}

// ============================================================
// Project Types
// ============================================================

export interface Project {
  id: number;
  name: string;
  description?: string;
  folder?: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Memory Types
// ============================================================

export const MemoryTypeSchema = z.enum(["short-term", "long-term", "episodic", "semantic"]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export interface MemoryEntry {
  id: number;
  conversationId?: number;
  type: MemoryType;
  content: string;
  importance: number;
  createdAt: string;
}

// ============================================================
// Provider Types
// ============================================================

export const ProviderNameSchema = z.enum(["lmstudio", "openrouter", "openai", "ollama"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export interface ProviderConfig {
  name: ProviderName;
  baseUrl: string;
  apiKey?: string;
  model: string;
  defaultOptions?: GenerateOptions;
}

// ============================================================
// API Response Types
// ============================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export function createApiResponse<T>(data: T): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

export function createApiError(error: string): ApiResponse<never> {
  return {
    success: false,
    error,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================
// Utility Types
// ============================================================

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type Nullable<T> = T | null;

export function isNonNullable<T>(value: Nullable<T>): value is T {
  return value !== null && value !== undefined;
}

// ============================================================
// Speech-to-Text Provider Types
// ============================================================

export const SpeechToTextProviderNameSchema = z.enum(["openai", "ollama", "silero", "local", "nodejs-whisper"]);
export type SpeechToTextProviderName = z.infer<typeof SpeechToTextProviderNameSchema>;

export interface SpeechToTextProviderConfig {
  name: SpeechToTextProviderName;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface SpeechToTextProvider {
  readonly name: string;
  transcribe(audioBuffer: Buffer, options?: { language?: string }): Promise<string>;
}

// ============================================================
// Filesystem Utilities
// ============================================================

/**
 * Resolves a user/LLM-supplied relative path against a root directory,
 * rejecting anything that would escape it. Tolerates a redundant leading
 * "shared-workspace/" segment since some call sites hint file paths to the
 * LLM with that prefix and others don't - callers referencing a file back
 * may echo either form.
 */
export function resolveWithinRoot(root: string, relativePath: string): string {
  const withoutPrefix = String(relativePath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/^shared-workspace\/+/i, "")
    .trim();

  if (!withoutPrefix || withoutPrefix.includes("..")) {
    throw new Error(`Invalid path: ${relativePath}`);
  }

  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, withoutPrefix);
  if (absolute !== absoluteRoot && !absolute.startsWith(absoluteRoot + sep)) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }

  return absolute;
}

// ============================================================
// API Response Types
// ============================================================
