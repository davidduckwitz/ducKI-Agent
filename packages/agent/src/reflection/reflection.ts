import type { LLMProvider } from "@ducki/providers";
import type { LLMMessage } from "@ducki/shared";
import type { Logger } from "@ducki/logger";

/**
 * Quality levels for reflection evaluation.
 * - "poor": Response has significant issues or is missing key information
 * - "adequate": Response works but could be improved
 * - "good": Response is useful and mostly correct
 * - "excellent": Response fully addresses the request with no improvements needed
 */
export type ReflectionQuality = "poor" | "adequate" | "good" | "excellent";

/**
 * Reflection type indicates what kind of reflection pass this was.
 * - "normal": Initial quality evaluation of the response
 * - "meta": Secondary reflection after already applying improvements (meta-review)
 */
export type ReflectionType = "normal" | "meta";

export interface ReflectionResult {
  quality: ReflectionQuality;
  issues: string[];
  suggestions: string[];
  shouldRetry: boolean;
  improvedResponse?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Reflection: Quality Evaluation & Self-Improvement System
 *
 * The Reflection system provides automated quality checking of agent responses,
 * identifying issues and generating improved versions. This enables the agent to:
 *
 * 1. **Validate Response Quality**: Assess if the response adequately answers the user's request
 * 2. **Identify Issues**: Detect specific problems (missing info, inaccuracies, clarity issues)
 * 3. **Generate Improvements**: Propose better versions of the response
 * 4. **Self-Correct**: Iteratively improve responses up to reflectionMaxRetries limit
 * 5. **Learn from Feedback**: Optionally store quality insights in long-term memory
 *
 * ## Configuration (via Agent Settings)
 *
 * - `AGENT_ENABLE_REFLECTION`: Enable/disable reflection entirely
 * - `AGENT_REFLECTION_MAX_RETRIES`: Number of improvement attempts (1-3 recommended)
 * - `AGENT_REFLECTION_META_REVIEW`: Run second "meta" reflection after improvements
 * - `AGENT_REFLECTION_STORE_MEMORY`: Store quality insights in long-term memory for learning
 *
 * ## Reflection Modes
 *
 * ### Full Mode
 * Complete reflection enabled, allows reflectionMaxRetries improvement cycles.
 * Reflection adds quality assurance without significant performance impact.
 *
 * ### Lightweight Mode
 * Reflection disabled to prioritize speed (limited iterations 5).
 * Rationale: With only 5 iterations total, reflection might exceed budget.
 * Note: Can be enabled in future if response quality becomes issue.
 *
 * ### Chatbot Mode
 * Reflection disabled due to severe iteration limits (1-4 total).
 * Rationale: Only enough iterations for tool call + response.
 * Reflection would consume most/all remaining iterations.
 *
 * ## Reflection Flow
 *
 * 1. Agent generates response (finalResponse)
 * 2. If `enableReflection && reflectionMaxRetries > 0`:
 *    - Reflection.evaluate() called to assess quality
 *    - If shouldRetry=true and improvement possible: use improvedResponse
 *    - Loop up to reflectionMaxRetries times
 * 3. If `reflectionMetaReview` enabled after retries:
 *    - Run second reflection pass on already-improved response
 *    - Verify the improvements are solid
 * 4. If `reflectionStoreMemory` enabled:
 *    - Store quality insights (quality level, issues found, suggestions) in memory
 *    - Helps agent learn from its own self-evaluations
 *
 * ## Performance Considerations
 *
 * Each reflection evaluation costs:
 * - 1 LLM call (temperature=0.2, max 1000 tokens)
 * - ~200-400ms latency typical
 * - Minimal token cost (~200-500 tokens per reflection)
 *
 * reflectionMaxRetries=1 adds ~1 LLM call. reflectionMetaReview=true adds ~1 more.
 */
export class Reflection {
  constructor(
    private readonly provider: LLMProvider,
    private readonly logger: Logger
  ) {}

  /**
   * Evaluate agent response quality and optionally generate improvements.
   *
   * @param originalRequest The user's original request
   * @param agentResponse The agent's proposed response to evaluate
   * @param context Optional context info (e.g., "toolsUsed=shell,http; meta-review=true")
   * @returns ReflectionResult with quality assessment and optional improvements
   */
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
  "issues": ["list of specific issues found"],
  "suggestions": ["list of concrete improvements"],
  "shouldRetry": boolean,
  "improvedResponse": "optional improved version (only if shouldRetry=true and changes made)"
}

Guidelines:
- quality: Assess how well the response addresses the original request
- shouldRetry: true only if you can meaningfully improve the response
- improvedResponse: Provide only if you have concrete improvements to suggest`,
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
      result.inputTokens = response.usage.promptTokens;
      result.outputTokens = response.usage.completionTokens;
      result.totalTokens = response.usage.totalTokens;

      this.logger.debug("Reflection complete", {
        quality: result.quality,
        shouldRetry: result.shouldRetry,
        tokens: result.totalTokens,
      });
      return result;
    } catch (error) {
      this.logger.warn("Reflection evaluation failed, returning neutral result", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        quality: "adequate",
        issues: [],
        suggestions: [],
        shouldRetry: false,
      };
    }
  }
}
