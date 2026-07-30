/**
 * Completion Tool Pattern: Allows agents to explicitly signal completion.
 * This is different from implicit completion (no more tool calls).
 * Enables structured final responses and success/failure semantics.
 */

import type { ToolExecutor, ToolResult, ToolDefinition } from "@ducki/shared";

/**
 * Options for creating a completion tool.
 */
export interface CompletionToolOptions {
  /** Tool name (default: "submit_solution") */
  name?: string;
  /** Whether this tool completes the run immediately on success */
  completesRun?: boolean;
  /** Custom validation function for completion */
  validate?: (input: Record<string, unknown>) => { valid: boolean; reason?: string };
}

/**
 * Creates a completion tool that agents can call to explicitly end the run.
 * Useful for:
 * - Marking a task as complete with structured output
 * - Distinguishing between "I'm done" vs "I have nothing more to say"
 * - Requiring explicit agent intent rather than implicit detection
 */
export function createCompletionTool(options: CompletionToolOptions = {}): ToolExecutor {
  const toolName = options.name ?? "submit_solution";
  const completesRun = options.completesRun ?? true;
  const validate = options.validate;

  const definition: ToolDefinition = {
    name: toolName,
    description: `Submit final solution and complete the task. This signals that the agent has finished work and is ready to provide the final response.`,
  } as any; // schema defined externally in tool-registry

  return {
    name: toolName,
    description: definition.description,
    definition,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      // Validate input if custom validator provided
      if (validate) {
        const validation = validate(input);
        if (!validation.valid) {
          return {
            success: false,
            data: null,
            error: validation.reason ?? "Completion validation failed",
          };
        }
      }

      // Required fields
      const summary = String(input.summary ?? "");
      const success = Boolean(input.success);

      if (!summary) {
        return {
          success: false,
          data: null,
          error: "Completion requires 'summary' field",
        };
      }

      // Return structured completion
      return {
        success: true,
        data: {
          toolName,
          completed: true,
          completesRun,
          summary,
          success,
          details: input.details ?? {},
          timestamp: new Date().toISOString(),
        },
      };
    },
  };
}

/**
 * CodingCompletion: Specialized completion tool for coding tasks.
 * Requires verification before allowing completion.
 */
export function createCodingCompletionTool(options: {
  verifyCommand?: string;
  requiresVerification?: boolean;
} = {}): ToolExecutor {
  return createCompletionTool({
    name: "submit_code",
    completesRun: true,
    validate: (input) => {
      if (options.requiresVerification && !input.verified) {
        return {
          valid: false,
          reason: `Coding completion requires 'verified: true' (verification command: ${options.verifyCommand || "none"})`,
        };
      }

      const summary = String(input.summary ?? "");
      if (!summary) {
        return { valid: false, reason: "Code completion requires 'summary'" };
      }

      return { valid: true };
    },
  });
}

/**
 * ReviewCompletion: Specialized completion tool for review/analysis tasks.
 * Requires findings/recommendations before allowing completion.
 */
export function createReviewCompletionTool(): ToolExecutor {
  return createCompletionTool({
    name: "submit_review",
    completesRun: true,
    validate: (input) => {
      const summary = String(input.summary ?? "");
      const findings = input.findings;

      if (!summary) {
        return { valid: false, reason: "Review completion requires 'summary'" };
      }

      if (!findings || (Array.isArray(findings) && findings.length === 0)) {
        return { valid: false, reason: "Review completion requires 'findings' array with at least one finding" };
      }

      return { valid: true };
    },
  });
}
