import type { Plan } from "../components/chat/PlanExecutionPanel";

export function parseMarkdownToPlan(markdown: string): Plan | null {
  if (!markdown?.trim()) return null;

  const lines = markdown.split("\n");

  // Extract goal from heading
  const headingMatch = markdown.match(/^#{1,2}\s+(.+?)$/m);
  if (!headingMatch) return null;

  const title = headingMatch[1]!.trim();
  const goal = title.replace(/^Plan:\s*/i, "").trim() || title;

  // Extract complexity level
  let complexity = 3; // default: Mittel
  const complexityLower = markdown.toLowerCase();
  if (complexityLower.includes("hoch")) {
    complexity = 5;
  } else if (complexityLower.includes("niedrig")) {
    complexity = 1;
  } else if (complexityLower.includes("mittel")) {
    complexity = 3;
  }

  // Extract numbered steps
  const steps: Array<{ title: string; description: string; tools?: string[] }> = [];
  const stepRegex = /^\d+\.\s+\*\*(.+?)\*\*\n([\s\S]*?)(?=\n\d+\.|$)/gm;

  let stepMatch;
  while ((stepMatch = stepRegex.exec(markdown)) !== null) {
    const stepTitle = stepMatch[1]!.trim();
    const stepContent = stepMatch[2]!;

    // Extract description (first line(s) until tools or next content)
    const descMatch = stepContent.match(/^\s+(.+?)(?=\n\s*_Benötigte|$)/s);
    const stepDesc = descMatch ? descMatch[1]!.trim() : stepContent.trim();

    // Extract tools for this step
    const tools: string[] = [];

    // Find "Benötigte Tools:" or similar variations
    const toolsMatch = stepContent.match(/_Benötigte\s+Tools:\s*(.+?)(?=\n|$)/i);
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
