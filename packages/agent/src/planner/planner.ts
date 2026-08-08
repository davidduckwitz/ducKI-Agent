import type { LLMProvider } from "@ducki/providers";
import type { LLMMessage } from "@ducki/shared";
import type { Logger } from "@ducki/logger";
import { TokenCounter } from "../context/token-counter.js";

export type RiskLevel = "low" | "medium" | "high";

/**
 * Optional cost/risk context for planning (Phase 3 "Strategist"). When a model
 * and budget are supplied, the planner converts each step's estimated tokens to
 * USD via the Phase 2 price table and, if the total exceeds the budget, attaches
 * a *downgrade suggestion* — it never switches models itself.
 */
export interface PlanCostOptions {
  /** Model the run currently uses, for token→USD conversion + downgrade hints. */
  currentModel?: string;
  /** Per-run budget in USD; 0/undefined disables the downgrade suggestion. */
  budgetUsd?: number;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  estimatedComplexity: "low" | "medium" | "high";
  estimatedComplexityScore?: number;
  totalSteps?: number;
  executionStrategy?: "sequential" | "parallel" | "hybrid";
  validationResult?: PlanValidationResult;
  // Phase 3 cost/risk
  totalEstimatedTokens?: number;
  totalEstimatedCostUsd?: number;
  overallRiskLevel?: RiskLevel;
  /** Non-binding advice when the estimate exceeds the budget. Never auto-applied. */
  downgradeSuggestion?: string;
}

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  toolsNeeded?: string[];
  dependsOn?: string[];
  canParallelizeWith?: string[];
  subtasks?: PlanSubtask[];
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
  estimatedDuration?: number;
  priority?: "critical" | "high" | "medium" | "low";
  // Phase 3 cost/risk
  estimatedTokens?: number;
  estimatedCostUsd?: number;
  riskLevel?: RiskLevel;
}

export interface PlanSubtask {
  id: string;
  title: string;
  description: string;
  toolsNeeded?: string[];
  dependsOn?: string[];
  status: "pending" | "running" | "completed" | "failed";
}

export interface PlanValidationResult {
  isValid: boolean;
  issues: string[];
  warnings: string[];
  stepCount: number;
  cyclicDependencies: string[];
  unusedSteps: string[];
}

export interface DependencyGraph {
  nodeIds: Set<string>;
  edges: Map<string, Set<string>>;
  parallelGroups: string[][];
}

const PLANNER_SYSTEM_PROMPT_V2 = `You are an expert task planning assistant. Break down goals into detailed, hierarchical steps.
Return ONLY valid JSON with this exact structure (no markdown, no extra text):
{
  "goal": "the main goal",
  "steps": [
    {
      "id": "step_1",
      "title": "Clear, concise step title (5-10 words)",
      "description": "Detailed description of what to do and why",
      "toolsNeeded": ["tool_name1", "tool_name2"],
      "dependsOn": [],
      "priority": "high|medium|low",
      "estimatedDuration": 300,
      "estimatedTokens": 1500,
      "riskLevel": "low|medium|high",
      "subtasks": [
        {
          "id": "step_1_a",
          "title": "Sub-task title",
          "description": "What to do",
          "toolsNeeded": ["tool"],
          "dependsOn": []
        }
      ]
    }
  ],
  "estimatedComplexity": "low|medium|high"
}

CRITICAL RULES:
1. For simple goals (1-2 steps): use "low" complexity
2. For moderate goals (3-5 steps): use "medium" complexity
3. For complex goals (6+ steps or multi-layered): use "high" complexity
4. Break complex steps into subtasks (max 3-4 per step)
5. Identify true dependencies - steps that MUST wait for others
6. Mark steps that CAN run in parallel (no dependencies between them)
7. Use realistic duration estimates in seconds (60=1min, 300=5min, 600=10min)
8. Estimate total LLM tokens each step will consume (input+output), realistic per step
9. Assess riskLevel per step: "high" = irreversible/destructive/external side effects or high uncertainty, "medium" = moderate, "low" = safe/read-only
10. Always return valid, parseable JSON`;

const VALIDATION_PROMPT = `Validate this plan and suggest improvements:
${JSON.stringify({}, null, 2)}

Return JSON with structure:
{
  "isValid": true|false,
  "issues": ["issue1"],
  "warnings": ["warning1"],
  "suggestions": ["suggestion1"],
  "canParallelizeSteps": [["step_id1", "step_id2"]]
}`;

export class Planner {
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 500;

  constructor(
    private readonly provider: LLMProvider,
    private readonly logger: Logger
  ) {}

  async createPlan(
    goal: string,
    availableTools: string[] = [],
    costOptions?: PlanCostOptions
  ): Promise<Plan> {
    this.logger.info("Creating plan", { goal: goal.substring(0, 200) });

    const toolsContext =
      availableTools.length > 0
        ? `\nAvailable tools: ${availableTools.join(", ")}`
        : "";

    const truncatedGoal = goal.length > 2000
      ? goal.substring(0, 2000) + "\n[...truncated]"
      : goal;

    let plan: Plan | null = null;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const messages: LLMMessage[] = [
          { role: "system", content: PLANNER_SYSTEM_PROMPT_V2 },
          {
            role: "user",
            content: `Create a detailed plan for: ${truncatedGoal}${toolsContext}`,
          },
        ];

        const response = await this.provider.generate(messages, {
          temperature: 0.3,
          maxTokens: 4000,
        });

        let parsedPlan = this.parsePlanJSON(response.content);
        if (parsedPlan) {
          parsedPlan = this.initializePlanSteps(parsedPlan);
          parsedPlan = await this.analyzeDependencies(parsedPlan);
          parsedPlan = await this.validatePlan(parsedPlan);
          parsedPlan = this.computeCostAndRisk(parsedPlan, costOptions);

          this.logger.info("Plan created successfully", {
            goal,
            steps: parsedPlan.steps.length,
            complexity: parsedPlan.estimatedComplexity,
            executionStrategy: parsedPlan.executionStrategy,
            attempt: attempt + 1,
          });

          return parsedPlan;
        }

        lastError = new Error("Failed to parse plan JSON");
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn("Plan creation attempt failed", {
          attempt: attempt + 1,
          error: lastError.message,
        });

        if (attempt < this.maxRetries - 1) {
          await this.delay(this.retryDelayMs * Math.pow(2, attempt));
        }
      }
    }

    this.logger.warn("Plan creation failed after all retries, using fallback", {
      error: lastError?.message,
    });

    return this.createFallbackPlan(goal);
  }

  async refinePlan(plan: Plan, feedback: string): Promise<Plan> {
    this.logger.info("Refining plan", { feedback: feedback.substring(0, 100) });

    try {
      const messages: LLMMessage[] = [
        { role: "system", content: PLANNER_SYSTEM_PROMPT_V2 },
        {
          role: "user",
          content: `Refine this plan based on feedback:\n\nOriginal plan: ${JSON.stringify(plan, null, 2)}\n\nFeedback: ${feedback}`,
        },
      ];

      const response = await this.provider.generate(messages, { temperature: 0.3, maxTokens: 4000 });
      const refined = this.parsePlanJSON(response.content);

      if (refined) {
        return await this.analyzeDependencies(this.initializePlanSteps(refined));
      }

      return plan;
    } catch (error) {
      this.logger.warn("Plan refinement failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return plan;
    }
  }

  private parsePlanJSON(content: string): Plan | null {
    try {
      const cleaned = content
        .replace(/^```json\s*/, "")
        .replace(/```\s*$/, "")
        .replace(/^```\s*/, "")
        .trim();

      const parsed = JSON.parse(cleaned) as Plan;
      return parsed;
    } catch (error) {
      this.logger.debug("JSON parse failed", {
        error: error instanceof Error ? error.message : String(error),
        contentPreview: content.substring(0, 200),
      });
      return null;
    }
  }

  private initializePlanSteps(plan: Plan): Plan {
    plan.steps = plan.steps.map((step, idx) => ({
      ...step,
      id: step.id || `step_${idx + 1}`,
      status: step.status || "pending",
      priority: step.priority || "medium",
      estimatedDuration: step.estimatedDuration || 300,
    }));

    plan.totalSteps = plan.steps.length;
    plan.estimatedComplexityScore = this.calculateComplexityScore(plan);

    return plan;
  }

  private async analyzeDependencies(plan: Plan): Promise<Plan> {
    const graph = this.buildDependencyGraph(plan.steps);
    const cycles = this.detectCycles(graph);

    if (cycles.length > 0) {
      this.logger.warn("Cyclic dependencies detected, attempting to resolve", { cycles });
      plan.steps = this.resolveCycles(plan.steps, cycles);
    }

    plan = this.detectParallelGroups(plan, graph);
    plan.executionStrategy = this.determineExecutionStrategy(plan);

    return plan;
  }

  private buildDependencyGraph(steps: PlanStep[]): DependencyGraph {
    const nodeIds = new Set(steps.map((s) => s.id));
    const edges = new Map<string, Set<string>>();

    for (const step of steps) {
      edges.set(step.id, new Set(step.dependsOn || []));
    }

    return { nodeIds, edges, parallelGroups: [] };
  }

  private detectCycles(graph: DependencyGraph): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const visit = (node: string, path: string[]): void => {
      visited.add(node);
      recStack.add(node);
      const currentPath = [...path, node];

      const neighbors = graph.edges.get(node) || new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visit(neighbor, currentPath);
        } else if (recStack.has(neighbor)) {
          const cycleStart = currentPath.indexOf(neighbor);
          cycles.push(currentPath.slice(cycleStart));
        }
      }

      recStack.delete(node);
    };

    for (const node of graph.nodeIds) {
      if (!visited.has(node)) {
        visit(node, []);
      }
    }

    return cycles;
  }

  private resolveCycles(steps: PlanStep[], cycles: string[][]): PlanStep[] {
    for (const cycle of cycles) {
      const lastStep = cycle[cycle.length - 1];
      const stepToUpdate = steps.find((s) => s.id === lastStep);
      if (stepToUpdate && stepToUpdate.dependsOn) {
        stepToUpdate.dependsOn = stepToUpdate.dependsOn.filter(
          (dep) => !cycle.includes(dep)
        );
      }
    }
    return steps;
  }

  private detectParallelGroups(plan: Plan, graph: DependencyGraph): Plan {
    const parallelGroups: string[][] = [];
    const levels = this.topologicalSort(graph);

    for (const level of levels) {
      if (level.length > 1) {
        parallelGroups.push(level);
      }
    }

    for (const step of plan.steps) {
      const parallelGroup = parallelGroups.find((g) => g.includes(step.id));
      if (parallelGroup) {
        step.canParallelizeWith = parallelGroup.filter((id) => id !== step.id);
      }
    }

    return plan;
  }

  private topologicalSort(graph: DependencyGraph): string[][] {
    const levels: string[][] = [];
    const visited = new Set<string>();
    const inDegree = new Map<string, number>();

    for (const node of graph.nodeIds) {
      inDegree.set(node, graph.edges.get(node)?.size || 0);
    }

    while (visited.size < graph.nodeIds.size) {
      const currentLevel = Array.from(graph.nodeIds).filter(
        (node) => !visited.has(node) && (inDegree.get(node) || 0) === 0
      );

      if (currentLevel.length === 0) break;

      levels.push(currentLevel);

      for (const node of currentLevel) {
        visited.add(node);
        for (const [target, deps] of graph.edges) {
          if (deps.has(node)) {
            inDegree.set(target, (inDegree.get(target) || 0) - 1);
          }
        }
      }
    }

    return levels;
  }

  private determineExecutionStrategy(plan: Plan): "sequential" | "parallel" | "hybrid" {
    const hasParallel = plan.steps.some((s) => s.canParallelizeWith?.length);
    const hasSequential = plan.steps.some((s) => s.dependsOn?.length);

    if (hasParallel && hasSequential) return "hybrid";
    if (hasParallel) return "parallel";
    return "sequential";
  }

  private async validatePlan(plan: Plan): Promise<Plan> {
    const validation: PlanValidationResult = {
      isValid: true,
      issues: [],
      warnings: [],
      stepCount: plan.steps.length,
      cyclicDependencies: [],
      unusedSteps: [],
    };

    if (plan.steps.length === 0) {
      validation.isValid = false;
      validation.issues.push("Plan has no steps");
    }

    if (plan.steps.length > 20) {
      validation.warnings.push(`Plan is very large (${plan.steps.length} steps), consider breaking it down`);
    }

    for (const step of plan.steps) {
      if (!step.title || step.title.trim().length === 0) {
        validation.issues.push(`Step ${step.id} has no title`);
      }
      if (!step.description || step.description.trim().length === 0) {
        validation.warnings.push(`Step ${step.id} has no description`);
      }
    }

    const stepIds = new Set(plan.steps.map((s) => s.id));
    for (const step of plan.steps) {
      if (step.dependsOn) {
        for (const dep of step.dependsOn) {
          if (!stepIds.has(dep)) {
            validation.issues.push(`Step ${step.id} depends on non-existent step ${dep}`);
          }
        }
      }
    }

    plan.validationResult = validation;
    return plan;
  }

  /**
   * Phase 3: aggregate per-step token estimates into a total, convert to USD via
   * the current model's price table, roll up an overall risk level, and — only
   * when over budget — attach a downgrade *suggestion*. Never switches models.
   */
  private computeCostAndRisk(plan: Plan, options?: PlanCostOptions): Plan {
    const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
    const model = options?.currentModel;

    let totalTokens = 0;
    let maxRisk: RiskLevel = "low";

    for (const step of plan.steps) {
      const tokens = typeof step.estimatedTokens === "number" && step.estimatedTokens > 0
        ? Math.round(step.estimatedTokens)
        : undefined;
      if (tokens) {
        step.estimatedTokens = tokens;
        totalTokens += tokens;
        if (model) {
          // Split heuristically ~70% input / 30% output for a rough per-step cost.
          const { totalCost } = TokenCounter.estimateCostFromTokens(
            model,
            Math.round(tokens * 0.7),
            Math.round(tokens * 0.3)
          );
          step.estimatedCostUsd = Number(totalCost.toFixed(6));
        }
      }
      const risk: RiskLevel = step.riskLevel === "high" || step.riskLevel === "medium" ? step.riskLevel : "low";
      step.riskLevel = risk;
      if (rank[risk] > rank[maxRisk]) maxRisk = risk;
    }

    plan.overallRiskLevel = maxRisk;
    if (totalTokens > 0) {
      plan.totalEstimatedTokens = totalTokens;
      if (model) {
        const { totalCost } = TokenCounter.estimateCostFromTokens(
          model,
          Math.round(totalTokens * 0.7),
          Math.round(totalTokens * 0.3)
        );
        plan.totalEstimatedCostUsd = Number(totalCost.toFixed(6));
      }
    }

    const budget = options?.budgetUsd ?? 0;
    if (budget > 0 && (plan.totalEstimatedCostUsd ?? 0) > budget) {
      plan.downgradeSuggestion =
        `Die geschätzten Kosten (${plan.totalEstimatedCostUsd!.toFixed(4)} USD) übersteigen das Budget von ${budget.toFixed(2)} USD. ` +
        `Erwäge ein günstigeres/kleineres Modell für Teile dieses Plans. ` +
        `Hinweis: Ich wechsle das Modell NICHT automatisch — das ist deine Entscheidung.`;
      this.logger.info("Plan exceeds budget, downgrade suggested (not applied)", {
        totalEstimatedCostUsd: plan.totalEstimatedCostUsd,
        budgetUsd: budget,
        model,
      });
    }

    return plan;
  }

  private calculateComplexityScore(plan: Plan): number {
    let score = 1;

    score += Math.min(plan.steps.length / 2, 3);
    score += plan.steps.filter((s) => s.subtasks?.length).length * 1.5;
    score += plan.steps.filter((s) => s.dependsOn?.length).length * 0.5;

    return Math.round(score * 10) / 10;
  }

  private createFallbackPlan(goal: string): Plan {
    return {
      goal,
      steps: [
        {
          id: "step_1",
          title: "Execute task",
          description: goal,
          status: "pending",
          priority: "high",
          estimatedDuration: 600,
        },
      ],
      estimatedComplexity: "low",
      estimatedComplexityScore: 1,
      totalSteps: 1,
      executionStrategy: "sequential",
      validationResult: {
        isValid: false,
        issues: ["Plan generation failed, using fallback single-step plan"],
        warnings: [],
        stepCount: 1,
        cyclicDependencies: [],
        unusedSteps: [],
      },
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
