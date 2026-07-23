import type { LLMProvider } from "@ducki/providers";
import type { LLMMessage } from "@ducki/shared";
import type { Logger } from "@ducki/logger";

export interface ReflectionResult {
  quality: "poor" | "adequate" | "good" | "excellent";
  issues: string[];
  suggestions: string[];
  shouldRetry: boolean;
  improvedResponse?: string;
}

export class Reflection {
  constructor(
    private readonly provider: LLMProvider,
    private readonly logger: Logger
  ) {}

  async evaluate(
    originalRequest: string,
    agentResponse: string,
    context?: string
  ): Promise<ReflectionResult> {
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `You are a quality evaluation assistant. Evaluate the agent's response and return JSON:
{
  "quality": "poor|adequate|good|excellent",
  "issues": ["list of issues"],
  "suggestions": ["list of improvements"],
  "shouldRetry": boolean,
  "improvedResponse": "optional improved version"
}`,
      },
      {
        role: "user",
        content: `Evaluate this response:

Original request: ${originalRequest}
${context ? `Context: ${context}` : ""}

Agent response: ${agentResponse}

Return JSON evaluation only.`,
      },
    ];

    try {
      const response = await this.provider.generate(messages, {
        temperature: 0.2,
        maxTokens: 1000,
      });

      const result = JSON.parse(response.content) as ReflectionResult;
      this.logger.debug("Reflection complete", { quality: result.quality });
      return result;
    } catch {
      return {
        quality: "adequate",
        issues: [],
        suggestions: [],
        shouldRetry: false,
      };
    }
  }
}
