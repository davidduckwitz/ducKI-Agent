/**
 * Edge Functions Agent SDK
 * Optimized for serverless runtimes: Cloudflare Workers, AWS Lambda, Vercel Edge Functions.
 * Stateless, minimal dependencies, optimized for cold starts.
 */

import type { LLMProvider } from "@ducki/providers";
import type { LLMMessage, ToolResult } from "@ducki/shared";
import type { AgentRunOptions } from "../config/interfaces_types.js";
import type { SDKTool, SDKToolRegistry, AgentIteration, AgentSDK } from "../core/agent-sdk-interfaces.js";

/**
 * Minimal HTTP request/response types for edge functions.
 */
export interface EdgeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface EdgeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Edge-optimized tool registry (JSON-based, no objects).
 */
class EdgeToolRegistry implements SDKToolRegistry {
  private tools: Map<string, { name: string; description: string }>;

  constructor(toolsJson: string) {
    const toolsList = JSON.parse(toolsJson) as Array<{ name: string; description: string }>;
    this.tools = new Map(toolsList.map((t) => [t.name, t]));
  }

  getTool(name: string) {
    const info = this.tools.get(name);
    return info
      ? {
          name: info.name,
          description: info.description,
          async execute(input: Record<string, unknown>): Promise<ToolResult> {
            return { success: false, data: null, error: "Execute not available in edge" };
          },
        }
      : undefined;
  }

  listTools() {
    return Array.from(this.tools.values()).map((info) => ({
      name: info.name,
      description: info.description,
      async execute() {
        return { success: false, data: null, error: "Execute not available in edge" };
      },
    }));
  }

  hasTool(name: string) {
    return this.tools.has(name);
  }
}

/**
 * Edge-optimized SDK: stateless, minimal memory footprint.
 * Designed for Cloudflare Workers, AWS Lambda, Vercel Edge.
 */
export class EdgeAgentSDK implements AgentSDK {
  private toolRegistry: EdgeToolRegistry;

  constructor(toolsJson: string) {
    this.toolRegistry = new EdgeToolRegistry(toolsJson);
  }

  async executeIteration(config: {
    messages: LLMMessage[];
    systemPrompt: string;
    tools: SDKTool[];
    maxIterations: number;
    currentIteration: number;
  }): Promise<AgentIteration> {
    // Minimal iteration: just extract tool calls and return
    // Actual LLM call would be proxied to edge-compatible provider

    return {
      iteration: config.currentIteration,
      messages: config.messages,
      assistantMessage: "Edge function execution",
      toolCalls: [],
      toolResults: [],
      stopReason: "end_turn",
    };
  }

  extractToolCalls(response: string) {
    // Simple regex-based extraction for edge performance
    const pattern = /\[TOOL:(\w+)\(({.*?})\)\]/g;
    const calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];

    let match;
    while ((match = pattern.exec(response)) !== null) {
      try {
        calls.push({
          toolName: match[1] as string,
          input: JSON.parse(match[2] as string),
        });
      } catch {
        // Skip malformed calls
      }
    }

    return calls;
  }

  shouldStop(iteration: AgentIteration, maxIterations: number): boolean {
    return iteration.toolCalls.length === 0 || iteration.iteration >= maxIterations;
  }
}

/**
 * Edge Function Handler: HTTP request → agent execution → HTTP response.
 * Zero dependencies, fast cold starts.
 */
export async function handleEdgeAgentRequest(
  request: EdgeRequest,
  env: Record<string, string | undefined>
): Promise<EdgeResponse> {
  try {
    // Parse request
    if (!request.body) {
      return {
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Missing request body" }),
      };
    }

    const { userInput, conversationId } = JSON.parse(request.body);

    if (!userInput) {
      return {
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Missing userInput" }),
      };
    }

    // Create SDK
    const toolsJson = env.AVAILABLE_TOOLS ?? "[]";
    const sdk = new EdgeAgentSDK(toolsJson);

    // Extract tool calls from input (simplified for edge)
    const calls = sdk.extractToolCalls(userInput);

    // Return response
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId,
        iteration: 1,
        toolCalls: calls,
        stopReason: calls.length === 0 ? "no_tools" : "tool_calls",
      }),
    };
  } catch (error) {
    return {
      status: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    };
  }
}

/**
 * Cloudflare Worker handler example.
 *
 * export default {
 *   async fetch(request: Request, env: any) {
 *     const edgeRequest: EdgeRequest = {
 *       method: request.method,
 *       url: request.url,
 *       headers: Object.fromEntries(request.headers),
 *       body: await request.text(),
 *     };
 *     const response = await handleEdgeAgentRequest(edgeRequest, env);
 *     return new Response(response.body, {
 *       status: response.status,
 *       headers: response.headers,
 *     });
 *   },
 * };
 */
