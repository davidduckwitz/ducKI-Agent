import type { Logger } from "@ducki/logger";
import type { LLMMessage } from "@ducki/shared";

export interface ToolResult {
  toolName: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface FallbackResponseContext {
  userInput: string;
  attemptsSoFar: number;
  toolsExecuted: ToolResult[];
  errors: Error[];
  conversationHistory: LLMMessage[];
  state?: Record<string, unknown>;
}

/**
 * Generates fallback responses when normal LLM generation fails or times out.
 * Implements a 5-layer fallback strategy to ensure the agent always responds.
 *
 * Layer 1: Normal response (handled elsewhere)
 * Layer 2: Partial results from successful tools
 * Layer 3: Execution summary of what was attempted
 * Layer 4: Generic context-aware response
 * Layer 5: Emergency fallback
 */
export class FallbackResponseGenerator {
  constructor(private logger: Logger) {}

  /**
   * Generate a fallback response based on available context
   */
  async generateResponse(context: FallbackResponseContext): Promise<string> {
    this.logger.debug("Generating fallback response", {
      userInput: context.userInput.substring(0, 50),
      toolsExecuted: context.toolsExecuted.length,
      errors: context.errors.length,
      layer: this.determineLayer(context),
    });

    // Layer 2: Partial success - some tools succeeded
    if (context.toolsExecuted.length > 0) {
      const successfulTools = context.toolsExecuted.filter((t) => t.success);
      const failedTools = context.toolsExecuted.filter((t) => !t.success);

      if (successfulTools.length > 0 && failedTools.length > 0) {
        return this.createPartialSuccessResponse(context.userInput, successfulTools, failedTools);
      }

      // Layer 3: All tools were attempted but none succeeded
      if (failedTools.length === context.toolsExecuted.length) {
        return this.createExecutionSummaryResponse(context.userInput, context.toolsExecuted, context.errors);
      }

      // Tools executed but no clear outcome
      if (context.toolsExecuted.length > 0 && context.conversationHistory.length > 1) {
        return this.createPartialExecutionResponse(context.userInput, context.toolsExecuted);
      }
    }

    // Layer 4: Generic context-aware response (if we have conversation history)
    if (context.conversationHistory.length > 1) {
      return this.createGenericContextResponse(context.userInput, context.conversationHistory);
    }

    // Layer 5: Emergency fallback (minimal info)
    return this.createEmergencyResponse(context.userInput, context.errors);
  }

  /**
   * Determine which fallback layer will be used
   */
  private determineLayer(context: FallbackResponseContext): number {
    if (context.toolsExecuted.length === 0 && context.conversationHistory.length > 1) {
      return 4;
    }

    const successfulTools = context.toolsExecuted.filter((t) => t.success);
    const failedTools = context.toolsExecuted.filter((t) => !t.success);

    if (successfulTools.length > 0 && failedTools.length > 0) {
      return 2;
    }

    if (failedTools.length === context.toolsExecuted.length && context.toolsExecuted.length > 0) {
      return 3;
    }

    if (context.toolsExecuted.length > 0) {
      return 3;
    }

    return 5;
  }

  /**
   * Layer 2: Generate response when some tools succeeded
   */
  private createPartialSuccessResponse(
    userInput: string,
    successfulTools: ToolResult[],
    failedTools: ToolResult[]
  ): string {
    const successNames = successfulTools.map((t) => t.toolName).join(", ");
    const failedNames = failedTools.map((t) => t.toolName).join(", ");

    const successSummary = successfulTools
      .map((t) => {
        const data = t.data;
        const dataStr =
          typeof data === "string"
            ? data.substring(0, 100)
            : typeof data === "object"
              ? JSON.stringify(data).substring(0, 100)
              : String(data);
        return `- **${t.toolName}**: ${dataStr}`;
      })
      .join("\n");

    const failedSummary = failedTools.map((t) => `- **${t.toolName}**: ${t.error}`).join("\n");

    return `I've made partial progress on your request:

**Successful Operations:**
${successSummary}

**Unsuccessful Operations:**
${failedSummary}

I was able to complete the following tools successfully: ${successNames}. However, ${failedNames} encountered issues. The successful results are shown above. Please let me know if you'd like me to retry the failed operations or adjust the approach.`;
  }

  /**
   * Layer 3: Generate response when tools were attempted but failed
   */
  private createExecutionSummaryResponse(
    userInput: string,
    toolsExecuted: ToolResult[],
    errors: Error[]
  ): string {
    const summary = toolsExecuted.map((t) => `${t.toolName}: ${t.success ? "✓" : "✗"}`).join(", ");

    const errorSummary = errors.slice(0, 2).map((e) => e.message).join("; ");

    return `I attempted to address your request but encountered issues:

**Execution Attempts:**
${summary}

**Error Details:**
${errorSummary}

I executed the tools listed above, but they were unable to complete successfully. The errors indicate that: ${errorSummary}

This may be due to temporary issues, missing permissions, or network problems. You can try again, or let me know if you'd like to adjust the approach.`;
  }

  /**
   * Helper for partially successful execution
   */
  private createPartialExecutionResponse(userInput: string, toolsExecuted: ToolResult[]): string {
    const toolSummary = toolsExecuted
      .map((t) => {
        const status = t.success ? "✓ succeeded" : `✗ failed (${t.error})`;
        return `- ${t.toolName}: ${status}`;
      })
      .join("\n");

    return `I've executed several operations in response to your request:

**Execution Status:**
${toolSummary}

I've processed your request by executing the tools listed above. Some operations completed, while others encountered issues. The details above show which operations were successful and which were not.`;
  }

  /**
   * Layer 4: Generic response based on conversation context
   */
  private createGenericContextResponse(userInput: string, history: LLMMessage[]): string {
    const recentContext = history
      .slice(-3)
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter((c) => c.length > 0)
      .join("\n");

    return `I've reviewed your request: "${userInput}"

Unfortunately, I was unable to execute the necessary tools to provide a complete response at this moment. This may be due to:
- Temporary service unavailability
- Missing system resources or permissions
- Network connectivity issues

Based on our conversation, I understand you're looking for help with: ${recentContext.substring(0, 100)}...

Please try your request again, or provide additional details about what you'd like me to help with.`;
  }

  /**
   * Layer 5: Emergency fallback response
   */
  private createEmergencyResponse(userInput: string, errors: Error[]): string {
    const errorMsg = errors.length > 0 ? errors[0]!.message : "Unknown error";

    return `I encountered a technical issue while processing your request: "${userInput}"

**Error:** ${errorMsg}

Please try again in a moment, or simplify your request. If the problem persists, there may be a temporary system issue that will be resolved shortly.`;
  }
}
