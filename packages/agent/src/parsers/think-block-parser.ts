/**
 * ThinkBlockParser
 *
 * Parses multiple thinking/reasoning block formats from LLM outputs and extracts
 * structured information about the reasoning process.
 *
 * Supported formats:
 * - XML: <think>...</think>, <ant>...</ant>
 * - Markdown: ```thinking\n...\n```
 * - Custom: [THINKING]...[/THINKING]
 *
 * Features:
 * - Extracts tool call references from thinking content
 * - Estimates thinking depth (shallow/medium/deep)
 * - Calculates token usage estimates
 * - Maintains parsing statistics
 */

/** Represents a parsed think block with metadata and tool references */
export interface ThinkBlock {
  /** Unique identifier for this think block */
  id: string;
  /** Raw thinking content */
  content: string;
  /** When this block's thinking started */
  startTime: Date;
  /** When this block's thinking ended (set after completion) */
  endTime?: Date;
  /** Tool calls referenced in this thinking block */
  toolCalls: ToolCallReference[];
  /** Estimated depth of reasoning */
  thinkingDepth: "shallow" | "medium" | "deep";
  /** Estimated token count for this block's content */
  tokenEstimate?: number;
  /** Current parsing status */
  status: "streaming" | "complete";
}

/** Represents a tool call reference found in think block content */
export interface ToolCallReference {
  /** Position in content where tool was mentioned */
  position: number;
  /** Name of the tool */
  toolName: string;
  /** What the tool is supposed to do */
  purpose: string;
  /** Current status of this tool call */
  status: "planned" | "executing" | "completed" | "failed";
  /** Confidence level (0-1) that this is a real tool call */
  confidence: number;
}

/** Result of parsing a content string for think blocks */
export interface ParseResult {
  /** All think blocks found */
  thinkBlocks: ThinkBlock[];
  /** Content with think blocks removed */
  remainingContent: string;
  /** Aggregated statistics across all blocks */
  statistics: {
    totalThinkTokens: number;
    totalToolRefs: number;
    thinkingDepth: "shallow" | "medium" | "deep";
  };
}

/**
 * Parser for think blocks in LLM outputs.
 *
 * Handles multiple formats and extracts structured reasoning information.
 */
export class ThinkBlockParser {
  /**
   * Parse a string for think blocks in various formats.
   *
   * @param content - The content to parse
   * @returns ParseResult with extracted think blocks and remaining content
   */
  parse(content: string): ParseResult {
    const thinkBlocks: ThinkBlock[] = [];
    let remainingContent = content;
    const processedRanges: Array<{ start: number; end: number }> = [];

    // Process in order: XML first, then Markdown, then Custom (to avoid conflicts)
    this.extractXmlBlocks(content, thinkBlocks, processedRanges);
    this.extractMarkdownBlocks(content, thinkBlocks, processedRanges);
    this.extractCustomBlocks(content, thinkBlocks, processedRanges);

    // Remove think blocks from content (in reverse order to preserve positions)
    const sortedRanges = processedRanges.sort((a, b) => b.start - a.start);
    for (const range of sortedRanges) {
      remainingContent =
        remainingContent.slice(0, range.start) +
        remainingContent.slice(range.end);
    }

    // Note: Do NOT clean up multiple spaces - preserve original spacing

    // Calculate statistics
    const statistics = {
      totalThinkTokens: thinkBlocks.reduce(
        (sum, block) => sum + (block.tokenEstimate || 0),
        0
      ),
      totalToolRefs: thinkBlocks.reduce(
        (sum, block) => sum + block.toolCalls.length,
        0
      ),
      thinkingDepth: this.determineOverallDepth(thinkBlocks),
    };

    return {
      thinkBlocks,
      remainingContent,
      statistics,
    };
  }

  /**
   * Extract XML-format think blocks (<think>, <ant>)
   */
  private extractXmlBlocks(
    content: string,
    blocks: ThinkBlock[],
    ranges: Array<{ start: number; end: number }>
  ): void {
    const patterns = [
      { tag: "think", regex: /<think>([\s\S]*?)<\/think>/g },
      { tag: "ant", regex: /<ant>([\s\S]*?)<\/ant>/g },
    ];

    for (const { tag, regex } of patterns) {
      let match;
      while ((match = regex.exec(content)) !== null) {
        const thinkContent = match[1] ?? "";

        // Check if this range overlaps with already processed ranges
        if (this.rangeOverlaps(match.index, match.index + match[0].length, ranges)) {
          continue;
        }

        // A block that carries a real [TOOL:...] call is not pure reasoning - stripping it
        // here would silently swallow the call before tool extraction ever sees it (the
        // model still gets a "thinking" UI event and the file/action never happens, but the
        // checklist can still get marked done from the model's own claim that it did it).
        // Leave the whole range untouched so it flows through the normal response/tool path.
        if (this.containsToolCall(thinkContent)) {
          continue;
        }

        const block = this.createThinkBlock(thinkContent);
        blocks.push(block);
        ranges.push({
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }
  }

  /**
   * Extract Markdown-format think blocks (```thinking ... ```)
   */
  private extractMarkdownBlocks(
    content: string,
    blocks: ThinkBlock[],
    ranges: Array<{ start: number; end: number }>
  ): void {
    const regex = /```thinking\n([\s\S]*?)\n```/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      if (this.rangeOverlaps(match.index, match.index + match[0].length, ranges)) {
        continue;
      }

      const thinkContent = match[1] ?? "";
      if (this.containsToolCall(thinkContent)) {
        continue;
      }

      const block = this.createThinkBlock(thinkContent);
      blocks.push(block);
      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  /**
   * Extract custom format think blocks ([THINKING] ... [/THINKING])
   */
  private extractCustomBlocks(
    content: string,
    blocks: ThinkBlock[],
    ranges: Array<{ start: number; end: number }>
  ): void {
    const regex = /\[THINKING\]([\s\S]*?)\[\/THINKING\]/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      if (this.rangeOverlaps(match.index, match.index + match[0].length, ranges)) {
        continue;
      }

      const thinkContent = match[1] ?? "";
      if (this.containsToolCall(thinkContent)) {
        continue;
      }

      const block = this.createThinkBlock(thinkContent);
      blocks.push(block);
      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  /**
   * True if the content carries an actual [TOOL:...] marker (not just prose about tools).
   */
  private containsToolCall(content: string): boolean {
    return content.includes("[TOOL:");
  }

  /**
   * Create a ThinkBlock from raw thinking content
   */
  private createThinkBlock(content: string): ThinkBlock {
    // Clean up content
    const cleanedContent = content.trim();

    // Extract tool references
    const toolCalls = this.extractToolReferences(cleanedContent);

    // Determine thinking depth
    const thinkingDepth = this.determineThinkingDepth(cleanedContent);

    // Estimate tokens (1 token ≈ 4 characters, roughly)
    const tokenEstimate = Math.max(1, Math.ceil(cleanedContent.length / 4));

    return {
      id: this.generateId(),
      content: cleanedContent,
      startTime: new Date(),
      toolCalls,
      thinkingDepth,
      tokenEstimate,
      status: "streaming",
    };
  }

  /**
   * Extract tool call references from thinking content
   *
   * Detects patterns like:
   * - "rufe X auf um Y zu Z" (German)
   * - "call X to Y" (English)
   * - "verwende tool: X" (German)
   * - "use tool X" (English)
   */
  private extractToolReferences(
    thinkContent: string
  ): ToolCallReference[] {
    const references: ToolCallReference[] = [];

    // German patterns - Phase 4 Improvements: More patterns, refined confidence scores
    const germanPatterns = [
      {
        regex: /rufe\s+(\w+)\s+auf(?:\s+um\s+([^,.\n]*?))?(?=[,.\n]|$)/gi,
        toolIndex: 1,
        purposeIndex: 2,
        confidence: 0.95,
      },
      {
        regex: /verwende\s+(?:das\s+)?tool:\s*(\w+)(?:\s+(?:um|zu)\s+([^,.\n]*?))?(?=[,.\n]|$)/gi,
        toolIndex: 1,
        purposeIndex: 2,
        confidence: 0.88,
      },
      {
        regex: /nutze\s+(?:das\s+)?(\w+)(?:\s+um\s+([^,.\n]*?))?(?=[,.\n]|$)/gi,
        toolIndex: 1,
        purposeIndex: 2,
        confidence: 0.78,
      },
      {
        regex: /benutze\s+(?:das\s+)?(\w+)(?:\s+um\s+([^,.\n]*?))?(?=[,.\n]|$)/gi,
        toolIndex: 1,
        purposeIndex: 2,
        confidence: 0.75,
      },
      {
        regex: /aktiviere\s+(\w+)(?:\s+um\s+([^,.\n]*?))?(?=[,.\n]|$)/gi,
        toolIndex: 1,
        purposeIndex: 2,
        confidence: 0.72,
      },
    ];

    // English patterns - Phase 4 Improvements: More patterns, refined confidence scores
    const englishPatterns = [
      {
        regex: /call\s+(?:the\s+)?(\w+)(?:\s+to\s+([^,.\n]*?))?(?=[,.\n]|$)/gi,
        toolIndex: 1,
        purposeIndex: 2,
        confidence: 0.95,
      },
      {
        regex: /use\s+(?:the\s+)?(\w+)(?:\s+(?:to|for)\s+([^,.\n]*?))?(?=[,.\n]|$)/gi,
        toolIndex: 1,
        purposeIndex: 2,
        confidence: 0.82,
      },
      {
        regex: /invoke\s+(?:the\s+)?(\w+)(?:\s+to\s+([^,.\n]*?))?(?=[,.\n]|$)/gi,
        toolIndex: 1,
        purposeIndex: 2,
        confidence: 0.85,
      },
      {
        regex: /execute\s+(?:the\s+)?(\w+)(?:\s+to\s+([^,.\n]*?))?(?=[,.\n]|$)/gi,
        toolIndex: 1,
        purposeIndex: 2,
        confidence: 0.80,
      },
      {
        regex: /run\s+(?:the\s+)?(\w+)(?:\s+to\s+([^,.\n]*?))?(?=[,.\n]|$)/gi,
        toolIndex: 1,
        purposeIndex: 2,
        confidence: 0.78,
      },
    ];

    const allPatterns = [...germanPatterns, ...englishPatterns];

    for (const pattern of allPatterns) {
      let match;
      while ((match = pattern.regex.exec(thinkContent)) !== null) {
        const toolName = match[pattern.toolIndex]?.toLowerCase() || "";
        const rawPurpose = (match[pattern.purposeIndex] || "").trim();

        // Extract the meaningful part of the purpose (first few words, up to natural break)
        const purpose = rawPurpose.split(/\s+/).slice(0, 10).join(" ") || `Call ${toolName}`;

        if (toolName.length > 0) {
          const position = match.index;

          // Check for exact duplicates (same tool at same position)
          const isDuplicate = references.some(
            (ref) =>
              ref.toolName === toolName &&
              ref.position === position
          );

          if (!isDuplicate) {
            references.push({
              position,
              toolName,
              purpose: purpose,
              status: "planned",
              confidence: pattern.confidence,
            });
          }
        }
      }
    }

    // Sort by position
    references.sort((a, b) => a.position - b.position);

    return references;
  }

  /**
   * Determine thinking depth based on content length
   *
   * - shallow: < 50 tokens (< 200 chars)
   * - medium: 50-300 tokens (200-1200 chars)
   * - deep: > 300 tokens (> 1200 chars)
   */
  private determineThinkingDepth(
    content: string
  ): "shallow" | "medium" | "deep" {
    const tokenCount = Math.ceil(content.length / 4);

    if (tokenCount < 50) {
      return "shallow";
    } else if (tokenCount < 300) {
      return "medium";
    } else {
      return "deep";
    }
  }

  /**
   * Determine overall thinking depth from all blocks
   */
  private determineOverallDepth(
    blocks: ThinkBlock[]
  ): "shallow" | "medium" | "deep" {
    if (blocks.length === 0) return "shallow";

    const depths = blocks.map((b) => b.thinkingDepth);

    if (depths.includes("deep")) return "deep";
    if (depths.includes("medium")) return "medium";
    return "shallow";
  }

  /**
   * Check if a range overlaps with any existing ranges
   */
  private rangeOverlaps(
    start: number,
    end: number,
    ranges: Array<{ start: number; end: number }>
  ): boolean {
    return ranges.some(
      (range) =>
        (start >= range.start && start < range.end) ||
        (end > range.start && end <= range.end) ||
        (start <= range.start && end >= range.end)
    );
  }

  /**
   * Generate a unique ID for a think block
   */
  private generateId(): string {
    return `think_${Date.now()}_${Math.random()
      .toString(36)
      .substring(2, 9)}`;
  }
}
