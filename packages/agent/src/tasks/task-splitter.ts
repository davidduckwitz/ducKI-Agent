/**
 * Heuristic decomposition of a task description into a flat list of subtasks.
 * Deliberately does not model a dependency graph or subtask ids/status - those
 * are properties of real `tasks` table rows once committed (see
 * task-split-service.ts), not of this preview step.
 */

export interface SplitSubtask {
  title: string;
  description: string;
  estimatedMinutes?: number;
}

export interface SplitResult {
  subtasks: SplitSubtask[];
  complexity: number;
}

export class TaskSplitter {
  split(title: string, description: string): SplitResult {
    const goals = this.extractGoals(description);
    const complexity = this.estimateComplexity(description);
    const keywords = this.extractKeywords(description);

    const subtasks: SplitSubtask[] = [];

    if (goals.length > 1) {
      subtasks.push({
        title: "Plan & Design",
        description: `Analyze requirements and create a detailed plan for: "${title}"\n\nGoals to achieve:\n${goals
          .map((g, i) => `${i + 1}. ${g}`)
          .join("\n")}`,
        estimatedMinutes: Math.ceil(goals.length * 5),
      });
    }

    for (const goal of goals) {
      subtasks.push({
        title: this.truncateGoal(goal, 60),
        description: `${goal}\n\nContext: ${description.substring(0, 200)}${description.length > 200 ? "..." : ""}`,
        estimatedMinutes: this.estimateSubtaskMinutes(goal, keywords),
      });
    }

    if (goals.length > 1 && keywords.some((k) => k.includes("test"))) {
      subtasks.push({
        title: "Testing & Validation",
        description: "Test all components and verify goals are achieved",
        estimatedMinutes: 15,
      });
    }

    if (goals.length > 1) {
      subtasks.push({
        title: "Complete & Document",
        description: "Finalize all work, update documentation, and close the task",
        estimatedMinutes: 5,
      });
    }

    // If nothing decomposed (single, simple goal), fall back to one subtask
    // mirroring the parent so a split always returns at least one entry.
    if (subtasks.length === 0) {
      subtasks.push({
        title: this.truncateGoal(title, 60),
        description,
        estimatedMinutes: this.estimateSubtaskMinutes(description, keywords),
      });
    }

    return { subtasks, complexity };
  }

  private extractGoals(description: string): string[] {
    const goals: string[] = [];

    const goalPatterns = [
      /(?:goal|objective|target|deliver|achieve|complete):\s*([^.!?\n]+)/gi,
      /(?:must|should|need to):\s*([^.!?\n]+)/gi,
      /^-\s*([^.!?\n]+)$/gm,
    ];

    for (const pattern of goalPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(description)) !== null) {
        const goal = match[1]?.trim();
        if (goal && goal.length > 5 && !goals.includes(goal)) {
          goals.push(goal);
        }
      }
    }

    if (goals.length === 0) {
      const sentences = description.split(/[.!?]+/).filter((s) => s.trim().length > 10);
      return sentences.slice(0, 3).map((s) => s.trim());
    }

    return goals;
  }

  private estimateComplexity(description: string): number {
    let score = 3;

    const complexityPatterns = [
      { pattern: /integrate|refactor|architecture|design|optimize/i, weight: 2 },
      { pattern: /database|migration|schema|deploy/i, weight: 1.5 },
      { pattern: /security|encryption|authentication|validation/i, weight: 2 },
      { pattern: /performance|speed|cache|async/i, weight: 1.5 },
      { pattern: /test|coverage|mock|stub/i, weight: 1 },
      { pattern: /documentation|guide|readme|tutorial/i, weight: 0.5 },
      { pattern: /bug fix|patch|hotfix|issue/i, weight: 0.5 },
    ];

    for (const { pattern, weight } of complexityPatterns) {
      if (pattern.test(description)) {
        score += weight;
      }
    }

    if (description.length < 50) score -= 1;
    if (description.includes("?") && description.length < 100) score -= 1;
    if (description.match(/step|phase|stage|part/i)) score += 1;

    return Math.min(10, Math.max(1, Math.round(score)));
  }

  private extractKeywords(description: string): string[] {
    const keywords: string[] = [];
    const termPatterns = [
      /frontend|ui|react|vue|angular|component/gi,
      /backend|api|server|node|database|sql/gi,
      /infrastructure|devops|docker|kubernetes|ci\/cd/gi,
      /testing|unit|integration|e2e/gi,
      /documentation|docs|guide|tutorial/gi,
    ];

    for (const pattern of termPatterns) {
      if (pattern.test(description)) {
        const [firstTerm] = pattern.source.split("|");
        if (firstTerm) keywords.push(firstTerm);
      }
    }

    return keywords;
  }

  private truncateGoal(goal: string, maxLength: number): string {
    const clean = goal.replace(/^[-*•]\s*/, "").trim();
    if (clean.length <= maxLength) return clean;
    return clean.substring(0, maxLength - 3) + "...";
  }

  private estimateSubtaskMinutes(goal: string, keywords: string[]): number {
    let time = 5;

    if (goal.length > 100) time += 5;
    if (goal.includes(" and ")) time += 3;
    if (goal.includes(" or ")) time += 2;

    if (keywords.some((k) => k.includes("backend"))) time += 5;
    if (keywords.some((k) => k.includes("frontend"))) time += 4;
    if (keywords.some((k) => k.includes("test"))) time += 3;
    if (keywords.some((k) => k.includes("doc"))) time += 2;
    if (keywords.some((k) => k.includes("infra"))) time += 8;

    return Math.min(120, Math.max(3, time));
  }
}
