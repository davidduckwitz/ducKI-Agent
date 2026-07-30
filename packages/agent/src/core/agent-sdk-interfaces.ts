/**
 * Agent SDK Interfaces: Define the contract between stateless runtime (SDK)
 * and stateful host layer. Enables testing, composition, and reusability.
 *
 * This layer separates CONCERNS:
 * - SDK: Pure LLM loop logic, tool execution, decision making
 * - Host: Persistence, conversations, memory management, event emission
 *
 * Similar to how operating systems separate kernel (scheduling, syscalls)
 * from userspace (file I/O, networking), this separation makes the agent
 * testable with mocks and reusable in different contexts (Node, Browser,
 * edge functions, etc.).
 */

import type { LLMMessage, ToolResult } from "@ducki/shared";
import type { LLMProvider } from "@ducki/providers";

/**
 * A tool available to the agent.
 */
export interface SDKTool {
  name: string;
  description: string;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * Tool registry: provides tools to SDK without coupling to storage.
 */
export interface SDKToolRegistry {
  getTool(name: string): SDKTool | undefined;
  listTools(): SDKTool[];
  hasTool(name: string): boolean;
}

/**
 * SDK-facing interface for the LLM provider.
 * Abstracts model invocation without exposing provider details.
 */
export interface SDKLLMGateway {
  generate(
    messages: LLMMessage[],
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<{ text: string; stopReason: "tool_calls" | "max_tokens" | "end_turn" | "error" }>;
}

/**
 * A single iteration of the agent loop.
 * Maps to one LLM call and its resulting tool executions.
 */
export interface AgentIteration {
  iteration: number;
  messages: LLMMessage[];
  assistantMessage: string;
  toolCalls: Array<{ toolName: string; input: Record<string, unknown> }>;
  toolResults: Array<{ toolName: string; result: ToolResult }>;
  stopReason: string;
}

/**
 * Pure SDK: Stateless agent runtime.
 * Given an LLM gateway, tool registry, and messages, produces the next iteration.
 * No persistence, no side effects - just computation.
 */
export interface AgentSDK {
  /**
   * Execute one iteration of the agent loop.
   * Input: current messages, system prompt, tools.
   * Output: next messages + tool results.
   * No state modification - caller must persist messages if desired.
   */
  executeIteration(config: {
    messages: LLMMessage[];
    systemPrompt: string;
    tools: SDKTool[];
    maxIterations: number;
    currentIteration: number;
  }): Promise<AgentIteration>;

  /**
   * Parse tool calls from LLM response text.
   * Returns structured tool calls ready for execution.
   */
  extractToolCalls(response: string): Array<{ toolName: string; input: Record<string, unknown> }>;

  /**
   * Check if iteration should stop (no more tool calls, max iterations, etc.).
   */
  shouldStop(iteration: AgentIteration, maxIterations: number): boolean;
}

/**
 * Host-facing interface for persistence and state management.
 * Different hosts (Node server, Browser, edge) implement this differently.
 */
export interface AgentHost {
  /**
   * Persist a conversation for recovery/continuation.
   */
  saveConversation(id: string, messages: LLMMessage[]): Promise<void>;

  /**
   * Retrieve persisted conversation.
   */
  loadConversation(id: string): Promise<LLMMessage[] | undefined>;

  /**
   * Emit an event (for UI, logging, telemetry).
   */
  emitEvent(event: { type: string; message: string; data?: Record<string, unknown>; timestamp: string }): void;

  /**
   * Query external context (memory, skills, workflow state).
   */
  queryContext(key: string): Promise<unknown>;

  /**
   * Store learning or state for future runs.
   */
  storeContext(key: string, value: unknown): Promise<void>;
}

/**
 * Factory for creating SDK and Host instances.
 * Enables dependency injection and testing.
 */
export interface AgentFactory {
  createSDK(llmGateway: SDKLLMGateway, toolRegistry: SDKToolRegistry): AgentSDK;
  createHost(config: { conversationId?: string; emitEvent?: (e: any) => void }): AgentHost;
}

/**
 * Reference implementation pattern:
 *
 * // Create SDK (testable with mocks)
 * const sdk = factory.createSDK(mockLLM, mockTools);
 *
 * // Create host (different per environment)
 * const host = factory.createHost({ emitEvent: ui.onEvent });
 *
 * // Orchestrate: run loop
 * let messages = await host.loadConversation(conversationId) ?? [];
 * while (!done) {
 *   const iteration = await sdk.executeIteration({
 *     messages,
 *     systemPrompt: "...",
 *     tools: await toolRegistry.listTools(),
 *     maxIterations: 10,
 *     currentIteration: i,
 *   });
 *
 *   messages.push(iteration.assistantMessage);
 *   for (const result of iteration.toolResults) {
 *     messages.push(result as LLMMessage);
 *   }
 *
 *   await host.saveConversation(conversationId, messages);
 *   host.emitEvent({ type: "iteration_complete", message: "...", data: iteration });
 *
 *   done = sdk.shouldStop(iteration, maxIterations);
 * }
 */
