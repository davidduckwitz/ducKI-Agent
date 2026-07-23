import { z } from "zod";
// ============================================================
// Agent Types
// ============================================================
export const AgentStatusSchema = z.enum(["idle", "running", "paused", "error", "stopped"]);
export const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
// ============================================================
// Task Types
// ============================================================
export const TaskStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled"]);
export const TaskPrioritySchema = z.enum(["low", "medium", "high", "critical"]);
// ============================================================
// Memory Types
// ============================================================
export const MemoryTypeSchema = z.enum(["short-term", "long-term", "episodic", "semantic"]);
// ============================================================
// Provider Types
// ============================================================
export const ProviderNameSchema = z.enum(["lmstudio", "openrouter", "openai", "ollama"]);
export function createApiResponse(data) {
    return {
        success: true,
        data,
        timestamp: new Date().toISOString(),
    };
}
export function createApiError(error) {
    return {
        success: false,
        error,
        timestamp: new Date().toISOString(),
    };
}
export function isNonNullable(value) {
    return value !== null && value !== undefined;
}
// ============================================================
// Speech-to-Text Provider Types
// ============================================================
export const SpeechToTextProviderNameSchema = z.enum(["openai", "ollama", "silero", "local", "nodejs-whisper"]);
// ============================================================
// API Response Types
// ============================================================
//# sourceMappingURL=index.js.map