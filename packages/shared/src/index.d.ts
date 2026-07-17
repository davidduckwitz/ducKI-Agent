import { z } from "zod";
export declare const AgentStatusSchema: z.ZodEnum<["idle", "running", "paused", "error", "stopped"]>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export declare const MessageRoleSchema: z.ZodEnum<["user", "assistant", "system", "tool"]>;
export type MessageRole = z.infer<typeof MessageRoleSchema>;
export interface LLMMessage {
    role: MessageRole;
    content: string;
    toolCallId?: string;
    toolCalls?: ToolCall[];
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
    toolCalls?: ToolCall[];
    usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    model?: string;
    finishReason?: string;
}
export interface GenerateOptions {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    tools?: ToolDefinition[];
    stream?: boolean;
}
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}
export interface ToolResult {
    success: boolean;
    data: unknown;
    error?: string;
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
export declare const TaskStatusSchema: z.ZodEnum<["pending", "running", "completed", "failed", "cancelled"]>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export declare const TaskPrioritySchema: z.ZodEnum<["low", "medium", "high", "critical"]>;
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
export interface Project {
    id: number;
    name: string;
    description?: string;
    folder?: string;
    createdAt: string;
    updatedAt: string;
}
export declare const MemoryTypeSchema: z.ZodEnum<["short-term", "long-term", "episodic", "semantic"]>;
export type MemoryType = z.infer<typeof MemoryTypeSchema>;
export interface MemoryEntry {
    id: number;
    conversationId?: number;
    type: MemoryType;
    content: string;
    importance: number;
    createdAt: string;
}
export declare const ProviderNameSchema: z.ZodEnum<["lmstudio", "openrouter", "openai", "ollama"]>;
export type ProviderName = z.infer<typeof ProviderNameSchema>;
export interface ProviderConfig {
    name: ProviderName;
    baseUrl: string;
    apiKey?: string;
    model: string;
    defaultOptions?: GenerateOptions;
}
export interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
    timestamp: string;
}
export declare function createApiResponse<T>(data: T): ApiResponse<T>;
export declare function createApiError(error: string): ApiResponse<never>;
export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
export type Nullable<T> = T | null;
export declare function isNonNullable<T>(value: Nullable<T>): value is T;
//# sourceMappingURL=index.d.ts.map