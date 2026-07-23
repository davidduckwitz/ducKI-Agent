import type { LLMProvider } from "@ducki/providers";
import type { LLMMessage } from "@ducki/shared";
import type { Logger } from "@ducki/logger";

export interface ReasoningResult {
  thinking: string;
  action: "respond" | "use_tool" | "ask_clarification" | "complete";
  response?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  confidence: number;
}

const REASONING_PROMPT = `You are a reasoning module for an AI agent. Analyze the conversation and determine what to do next.
You must respond with a JSON object:
{
  "thinking": "your internal reasoning",
  "action": "respond|use_tool|ask_clarification|complete",
  "response": "if action is respond, the response text",
  "toolName": "if action is use_tool, the tool name",
  "toolInput": "if action is use_tool, the tool input as JSON object",
  "confidence": 0.0-1.0
}`;

export class Reasoner {
  constructor(
    private readonly provider: LLMProvider,
    private readonly logger: Logger
  ) {}

  async reason(
    messages: LLMMessage[],
    availableTools: string[],
    context?: string
  ): Promise<ReasoningResult> {
    const systemContent = [
      REASONING_PROMPT,
      availableTools.length > 0
        ? `Available tools: ${availableTools.join(", ")}`
        : "No tools available.",
      context ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const reasoningMessages: LLMMessage[] = [
      { role: "system", content: systemContent },
      ...messages,
      {
        role: "user",
        content: "What should the agent do next? Respond with JSON only.",
      },
    ];

    try {
      const response = await this.provider.generate(reasoningMessages, {
        temperature: 0.2,
        maxTokens: 1000,
      });

      const result = JSON.parse(response.content) as ReasoningResult;
      this.logger.debug("Reasoning complete", {
        action: result.action,
        confidence: result.confidence,
      });
      return result;
    } catch {
      this.logger.warn("Reasoning failed, defaulting to respond");
      return {
        thinking: "Failed to parse reasoning result",
        action: "respond",
        response: "I encountered an issue processing your request. Please try again.",
        confidence: 0.5,
      };
    }
  }
}
