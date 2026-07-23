import type { LLMProvider } from "@ducki/providers";
import type { LLMMessage } from "@ducki/shared";
import type { Logger } from "@ducki/logger";

export interface Plan {
  goal: string;
  steps: PlanStep[];
  estimatedComplexity: "low" | "medium" | "high";
}

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  toolsNeeded?: string[];
  dependsOn?: string[];
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
}

const PLANNER_SYSTEM_PROMPT = `You are a task planning assistant. When given a goal, break it down into clear, actionable steps.
Return a JSON object with this structure:
{
  "goal": "the main goal",
  "steps": [
    {
      "id": "step_1",
      "title": "Brief step title",
      "description": "Detailed description",
      "toolsNeeded": ["tool_name"],
      "dependsOn": []
    }
  ],
  "estimatedComplexity": "low|medium|high"
}
Only return valid JSON, no markdown or extra text.`;

export class Planner {
  constructor(
    private readonly provider: LLMProvider,
    private readonly logger: Logger
  ) {}

  async createPlan(goal: string, availableTools: string[] = []): Promise<Plan> {
    this.logger.info("Creating plan", { goal });

    const toolsContext =
      availableTools.length > 0
        ? `\nAvailable tools: ${availableTools.join(", ")}`
        : "";

    const messages: LLMMessage[] = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Create a plan for: ${goal}${toolsContext}`,
      },
    ];

    const response = await this.provider.generate(messages, {
      temperature: 0.3,
      maxTokens: 2000,
    });

    try {
      const plan = JSON.parse(response.content) as Plan;
      plan.steps = plan.steps.map((step) => ({ ...step, status: "pending" }));
      this.logger.info("Plan created", { goal, steps: plan.steps.length });
      return plan;
    } catch {
      this.logger.warn("Failed to parse plan, creating simple plan");
      return {
        goal,
        steps: [
          {
            id: "step_1",
            title: "Execute task",
            description: goal,
            status: "pending",
          },
        ],
        estimatedComplexity: "low",
      };
    }
  }

  async refinePlan(plan: Plan, feedback: string): Promise<Plan> {
    const messages: LLMMessage[] = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Refine this plan based on feedback:\n\nOriginal plan: ${JSON.stringify(plan)}\n\nFeedback: ${feedback}`,
      },
    ];

    const response = await this.provider.generate(messages, { temperature: 0.3 });

    try {
      return JSON.parse(response.content) as Plan;
    } catch {
      return plan;
    }
  }
}
