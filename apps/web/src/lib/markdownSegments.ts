export interface MarkdownSegment {
  type: "text" | "code";
  content: string;
  language?: string;
}

/**
 * Splits chat text into prose and fenced-code segments.
 *
 * An unterminated fence (the message is still streaming) is treated as code, so a block
 * does not visibly flip from prose to code the moment the closing fence arrives.
 *
 * Handles edge cases:
 * - Streaming messages with incomplete code blocks
 * - Multiple code blocks with mixed content
 * - Language identifiers with +, #, -, alphanumerics
 */
export function splitMarkdownSegments(input: string): MarkdownSegment[] {
  if (!input || input.trim().length === 0) return [];

  const segments: MarkdownSegment[] = [];
  let pos = 0;

  while (pos < input.length) {
    // Find next fence
    const fenceStart = input.indexOf("```", pos);

    if (fenceStart === -1) {
      // No more fences - rest is text
      const remaining = input.slice(pos);
      if (remaining.trim().length > 0) {
        segments.push({ type: "text", content: remaining });
      }
      break;
    }

    // Add text before fence
    const textBefore = input.slice(pos, fenceStart);
    if (textBefore.trim().length > 0) {
      segments.push({ type: "text", content: textBefore });
    }

    // Parse fence opening: ```language\n
    const afterFence = input.slice(fenceStart + 3);
    const langMatch = /^([a-zA-Z0-9+#-]*)\n?/.exec(afterFence);
    const language = langMatch?.[1] || "text";
    const contentStart = fenceStart + 3 + (langMatch?.[0].length ?? 0);

    // Find closing fence
    const fenceEnd = input.indexOf("```", contentStart);

    if (fenceEnd === -1) {
      // Unterminated fence (streaming) - treat rest as code
      const codeContent = input.slice(contentStart);
      segments.push({ type: "code", language, content: codeContent });
      break;
    }

    // Extract code between fences
    const codeContent = input.slice(contentStart, fenceEnd);
    segments.push({ type: "code", language, content: codeContent });

    pos = fenceEnd + 3;
  }

  // Filter out empty text segments
  return segments.filter((segment) => segment.type === "code" || segment.content.trim().length > 0);
}
