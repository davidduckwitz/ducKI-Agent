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
 */
export function splitMarkdownSegments(input: string): MarkdownSegment[] {
  if (!input) return [];

  const segments: MarkdownSegment[] = [];
  const fence = /```([a-zA-Z0-9+#-]*)\n?([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(input)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: input.slice(lastIndex, match.index) });
    }
    segments.push({
      type: "code",
      language: match[1] || "text",
      content: match[2] ?? "",
    });
    lastIndex = fence.lastIndex;
    // A zero-length match (empty trailing fence) would spin the loop forever.
    if (match[0].length === 0) fence.lastIndex += 1;
  }

  if (lastIndex < input.length) {
    segments.push({ type: "text", content: input.slice(lastIndex) });
  }

  return segments.filter((segment) => segment.type === "code" || segment.content.trim().length > 0);
}
