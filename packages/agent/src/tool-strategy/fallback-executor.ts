import type { Logger } from "@ducki/logger";
import type { EventEmitterV2 } from "../events/index.js";
import type { Executor } from "../executor/executor.js";
import type { ToolResult } from "@ducki/shared";
import { getFallbackChain } from "./tool-fallback-config.js";

export interface ExecutionContext {
  toolName: string;
  input: Record<string, unknown>;
  iteration: number;
}

/**
 * Fallback Executor wraps the standard executor to implement fallback chains
 * When primary tool fails, automatically tries fallback tools in sequence
 */
export class FallbackToolExecutor {
  constructor(
    private executor: Executor,
    private logger: Logger,
    private eventEmitter: EventEmitterV2
  ) {}

  /**
   * Execute tool with fallback chain support
   */
  async execute(
    toolName: string,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const chain = getFallbackChain(toolName);

    // If no fallbacks defined, execute primary directly
    if (chain.fallbacks.length === 0) {
      this.logger.debug("Executing tool (no fallback defined)", {
        toolName,
        iteration: context.iteration,
      });
      return await this.executor.execute(toolName, input);
    }

    const toolsToTry = [chain.primary, ...chain.fallbacks];

    if (chain.strategy === "sequential") {
      return await this.executeSequential(toolsToTry, input, context);
    } else {
      return await this.executeParallel(toolsToTry, input, context);
    }
  }

  /**
   * Try tools one after another until one succeeds
   */
  private async executeSequential(
    toolsToTry: string[],
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const results: ToolResult[] = [];

    for (let i = 0; i < toolsToTry.length; i++) {
      const tool = toolsToTry[i]!;
      const isPrimary = i === 0;

      try {
        this.logger.debug("Executing tool in fallback chain", {
          tool,
          isPrimary,
          position: i + 1,
          total: toolsToTry.length,
          iteration: context.iteration,
        });

        const result = await this.executor.execute(tool, input);

        if (result.success) {
          // Success! Report if fallback was used
          if (!isPrimary) {
            this.eventEmitter.emitEvent({
              type: "guardrail",
              message: `Fallback tool succeeded: ${tool} (primary ${toolsToTry[0]} failed)`,
              data: {
                primaryTool: toolsToTry[0],
                fallbackUsed: tool,
                position: i,
              },
              timestamp: new Date().toISOString(),
            });

            this.logger.info("Fallback tool execution succeeded", {
              primaryTool: toolsToTry[0],
              fallbackUsed: tool,
              position: i,
            });
          }

          return {
            ...result,
            data: {
              ...((result.data as Record<string, unknown>) ?? {}),
              _fallbackUsed: !isPrimary ? tool : null,
            },
          };
        }

        results.push(result);
        this.logger.warn("Tool execution failed, trying next", {
          tool,
          error: result.error,
          nextTool: toolsToTry[i + 1],
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.push({
          success: false,
          error: errorMsg,
          data: null,
        });

        this.logger.warn("Tool execution threw error, trying next", {
          tool,
          error: errorMsg,
          nextTool: toolsToTry[i + 1],
        });
      }
    }

    // All tools failed
    const errorDetails = results.map((r) => r.error).join("; ");
    const error = `All tools in fallback chain failed for '${toolsToTry[0]}': ${errorDetails}`;

    this.logger.error("All fallback tools exhausted", {
      toolChain: toolsToTry,
      errors: results.map((r) => r.error),
    });

    this.eventEmitter.emitEvent({
      type: "guardrail",
      message: `All fallback tools failed for ${toolsToTry[0]}`,
      data: {
        toolChain: toolsToTry,
        errors: results.map((r) => r.error),
      },
      timestamp: new Date().toISOString(),
    });

    return {
      success: false,
      error,
      data: null,
    };
  }

  /**
   * Execute multiple tools in parallel, use first success
   */
  private async executeParallel(
    toolsToTry: string[],
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<ToolResult> {
    this.logger.debug("Executing tools in parallel", {
      tools: toolsToTry,
      count: toolsToTry.length,
      iteration: context.iteration,
    });

    const promises = toolsToTry.map((tool) =>
      this.executor
        .execute(tool, input)
        .then((result) => ({ tool, result }))
        .catch((error) => ({
          tool,
          result: {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            data: null,
          },
        }))
    );

    const settled = await Promise.allSettled(promises);

    // Find first successful result
    for (const settlement of settled) {
      if (settlement.status === "fulfilled") {
        const { tool, result } = settlement.value;

        if (result.success) {
          const isPrimary = tool === toolsToTry[0];

          if (!isPrimary) {
            this.logger.info("Parallel fallback tool succeeded", {
              primaryTool: toolsToTry[0],
              fallbackUsed: tool,
            });

            this.eventEmitter.emitEvent({
              type: "guardrail",
              message: `Parallel fallback succeeded: ${tool}`,
              data: {
                primaryTool: toolsToTry[0],
                fallbackUsed: tool,
                executedParallel: true,
              },
              timestamp: new Date().toISOString(),
            });
          }

          return {
            ...result,
            data: {
              ...((result.data as Record<string, unknown>) ?? {}),
              _fallbackUsed: !isPrimary ? tool : null,
              _executedParallel: true,
            },
          };
        }
      }
    }

    // All parallel tools failed
    const errors = settled
      .map((s) => {
        if (s.status === "fulfilled") {
          return s.value.result.error ?? "Unknown error";
        }
        return "Promise rejection";
      })
      .join("; ");

    const error = `All parallel tools failed for '${toolsToTry[0]}': ${errors}`;

    this.logger.error("All parallel tools failed", {
      toolChain: toolsToTry,
      errors,
    });

    return {
      success: false,
      error,
      data: null,
    };
  }
}
