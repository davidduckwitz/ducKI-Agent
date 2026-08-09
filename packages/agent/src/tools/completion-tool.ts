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
  /** Optional JSON-schema parameters advertised to the model (defaults to summary/success/details). */
  parameters?: Record<string, unknown>;
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

  const defaultParameters: Record<string, unknown> = {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "REQUIRED. A concise summary of the final result / what was accomplished. This becomes the final response.",
      },
      success: {
        type: "boolean",
        description: "Whether the task was completed successfully (default true).",
      },
      details: {
        type: "object",
        description: "Optional structured details about the solution.",
      },
    },
    required: ["summary"],
  };

  const definition: ToolDefinition = {
    name: toolName,
    description: `Submit the final solution and complete the task. Call this once the work is done to provide the final response.`,
    parameters: options.parameters ?? defaultParameters,
  };

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
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "REQUIRED. Concise summary of the code change / what was implemented." },
        verified: { type: "boolean", description: `Set true only after verification${options.verifyCommand ? ` (run: ${options.verifyCommand})` : ""}.` },
        success: { type: "boolean", description: "Whether the task completed successfully (default true)." },
        details: { type: "object", description: "Optional structured details." },
      },
      required: options.requiresVerification ? ["summary", "verified"] : ["summary"],
    },
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
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "REQUIRED. Concise summary of the review / analysis." },
        findings: {
          type: "array",
          description: "REQUIRED. At least one finding.",
          items: { type: "object" },
        },
        success: { type: "boolean", description: "Whether the review completed successfully (default true)." },
        details: { type: "object", description: "Optional structured details." },
      },
      required: ["summary", "findings"],
    },
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
