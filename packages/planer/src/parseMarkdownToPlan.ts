export interface Plan {
  id?: number;
  goal: string;
  title?: string;
  complexity?: number;
  steps?: Array<{ title: string; description: string; tools?: string[] }>;
  tools?: string[];
  markdown?: string;
  status?: string;
  createdAt?: string;
}

export function parseMarkdownToPlan(markdown: string): Plan | null {
  if (!markdown?.trim()) return null;

  // The step regex below anchors on "**\n", which a CRLF document would never match -
  // normalize first so plans authored on Windows parse identically to LF ones. The
  // original text is still what gets returned as `markdown`.
  const source = markdown.replace(/\r\n/g, "\n");

  // Extract goal from heading
  const headingMatch = source.match(/^#{1,2}\s+(.+?)$/m);
  if (!headingMatch) return null;

  const title = headingMatch[1]!.trim();
  const goal = title.replace(/^Plan:\s*/i, "").trim() || title;

  // Extract complexity level - only from the complexity line itself, so a step
  // description containing e.g. "hochladen" cannot flip the whole plan to "Hoch".
  let complexity = 3; // default: Mittel
  const complexityLine = source.match(/^.*Komplexit(?:ä|ae)t.*$/im)?.[0]?.toLowerCase() ?? "";
  if (complexityLine.includes("hoch")) {
    complexity = 5;
  } else if (complexityLine.includes("niedrig")) {
    complexity = 1;
  }

  // Extract numbered steps
  const steps: Array<{ title: string; description: string; tools?: string[] }> = [];
  // "(?:^|\n)" instead of "^" with the /m flag: /m would also make the "$" in the
  // trailing lookahead match at every line end, cutting each description off after its
  // first line. Without it, "^" would only ever match at the very start of the document -
  // and every plan starts with its "## Plan: ..." heading, so no step matched at all.
  const stepRegex = /(?:^|\n)\d+\.\s+\*\*(.+?)\*\*\n([\s\S]*?)(?=\n\d+\.|$)/g;

  let stepMatch;
  while ((stepMatch = stepRegex.exec(source)) !== null) {
    const stepTitle = stepMatch[1]!.trim();
    const stepContent = stepMatch[2]!;

    // Extract description (first line(s) until tools or next content)
    const descMatch = stepContent.match(/^\s+(.+?)(?=\n\s*_?Ben(?:ö|oe)tigte|$)/s);
    const stepDesc = descMatch ? descMatch[1]!.trim() : stepContent.trim();

    // Extract tools for this step
    const tools: string[] = [];

    // Find "Benötigte Tools:" - the ASCII "Benoetigte" spelling is what the plan
    // renderer actually emits, so both spellings must be accepted here.
    const toolsMatch = stepContent.match(/_?Ben(?:ö|oe)tigte\s+Tools:\s*(.+?)_?(?=\n|$)/i);
    if (toolsMatch && toolsMatch[1]) {
      // Remove markdown formatting and split by comma
      const cleanedTools = toolsMatch[1]
        .replace(/[_*]/g, "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      tools.push(...cleanedTools);
    }

    steps.push({
      title: stepTitle,
      description: stepDesc,
      ...(tools.length > 0 && { tools }),
    });
  }

  // At least need goal and steps for valid plan
  if (!goal || steps.length === 0) return null;

  return {
    goal,
    title,
    complexity,
    steps,
    markdown,
  };
}
