import type { Logger } from "@ducki/logger";
import { ToolStagingManager } from "./tool-staging-manager";

export interface ToolResponseHandlerOptions {
  minContentSize?: number; // Threshold to stage large responses (default: 5KB)
  maxSummaryLength?: number; // Max summary chars (default: 200)
}

export interface HandledToolResponse {
  /** Brief summary for messages */
  summary: string;
  /** Is content staged in file? */
  isStaged: boolean;
  /** Staging ID if staged */
  stagingId?: string;
  /** Direct content if not staged */
  content?: string;
  /** Markdown formatting hint */
  format: "inline" | "staged";
}

/**
 * Handles tool responses with hybrid approach:
 * - Small responses: Direct inline (messages)
 * - Large responses: Staged to file + summary in message
 */
export class ToolResponseHandler {
  private minContentSize: number;
  private maxSummaryLength: number;

  constructor(
    private readonly logger: Logger,
    private readonly stagingManager: ToolStagingManager,
    options: ToolResponseHandlerOptions = {}
  ) {
    this.minContentSize = options.minContentSize ?? 5 * 1024; // 5KB
    this.maxSummaryLength = options.maxSummaryLength ?? 200;
  }

  /**
   * Process tool response and decide: inline or staged
   */
  async handle(
    toolName: string,
    content: string,
    metadata?: { error?: boolean; duration?: number }
  ): Promise<HandledToolResponse> {
    const contentSize = Buffer.byteLength(content, "utf-8");
    const isLarge = contentSize > this.minContentSize;

    // Generate summary
    const summary = this.generateSummary(content, metadata, contentSize);

    if (isLarge) {
      // Stage large content
      this.logger.debug("Staging large tool response", {
        toolName,
        contentSize,
        threshold: this.minContentSize,
      });

      const staged = await this.stagingManager.stageToolResponse(
        toolName,
        content,
        summary
      );

      return {
        summary: `📁 ${summary}\n\n_[Large response staged: ${staged.id.substring(0, 8)}...](tool-staging://${staged.id})_`,
        isStaged: true,
        stagingId: staged.id,
        format: "staged",
      };
    } else {
      // Keep inline
      this.logger.debug("Inline tool response", {
        toolName,
        contentSize,
      });

      return {
        summary,
        isStaged: false,
        content,
        format: "inline",
      };
    }
  }

  /**
   * Generate summary from tool response
   */
  private generateSummary(
    content: string,
    metadata?: { error?: boolean; duration?: number },
    contentSize?: number
  ): string {
    if (metadata?.error) {
      return `❌ Error (${Math.round((contentSize ?? 0) / 1024)}KB)`;
    }

    // Extract first meaningful line
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) {
      return "✓ Completed";
    }

    const firstLine = lines[0] ?? "";
    const truncated =
      firstLine.length > this.maxSummaryLength
        ? `${firstLine.substring(0, this.maxSummaryLength)}...`
        : firstLine;

    const sizeInfo = contentSize
      ? ` (${Math.round(contentSize / 1024)}KB)`
      : "";
    const durationInfo = metadata?.duration
      ? ` [${Math.round(metadata.duration)}ms]`
      : "";

    return `✓ ${truncated}${sizeInfo}${durationInfo}`;
  }

  /**
   * Format response for message output
   */
  formatForMessage(response: HandledToolResponse): string {
    return response.summary;
  }

  /**
   * Format response for agent analysis (full content)
   */
  async formatForAgent(
    response: HandledToolResponse
  ): Promise<string> {
    if (response.isStaged && response.stagingId) {
      // Return reference + instruction to read
      return [
        `Tool response staged in: \`tool-staging://${response.stagingId}\``,
        "",
        "To analyze this response:",
        "1. Read the full content from the staged file",
        "2. Analyze as needed",
        "3. After analysis, delete: `tool-staging://delete/${response.stagingId}`",
      ].join("\n");
    }

    // Return inline content
    return response.content ?? response.summary;
  }
}

// Global handler
let globalHandler: ToolResponseHandler | undefined;

export function getToolResponseHandler(
  logger?: Logger,
  stagingManager?: ToolStagingManager,
  options?: ToolResponseHandlerOptions
): ToolResponseHandler | undefined {
  if (logger && stagingManager && !globalHandler) {
    globalHandler = new ToolResponseHandler(logger, stagingManager, options);
  }
  return globalHandler;
}

export function initToolResponseHandler(
  logger: Logger,
  stagingManager: ToolStagingManager,
  options?: ToolResponseHandlerOptions
): ToolResponseHandler {
  globalHandler = new ToolResponseHandler(logger, stagingManager, options);
  return globalHandler;
}
