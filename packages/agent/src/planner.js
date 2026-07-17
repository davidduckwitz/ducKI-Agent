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
    provider;
    logger;
    constructor(provider, logger) {
        this.provider = provider;
        this.logger = logger;
    }
    async createPlan(goal, availableTools = []) {
        this.logger.info("Creating plan", { goal });
        const toolsContext = availableTools.length > 0
            ? `\nAvailable tools: ${availableTools.join(", ")}`
            : "";
        const messages = [
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
            const plan = JSON.parse(response.content);
            plan.steps = plan.steps.map((step) => ({ ...step, status: "pending" }));
            this.logger.info("Plan created", { goal, steps: plan.steps.length });
            return plan;
        }
        catch {
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
    async refinePlan(plan, feedback) {
        const messages = [
            { role: "system", content: PLANNER_SYSTEM_PROMPT },
            {
                role: "user",
                content: `Refine this plan based on feedback:\n\nOriginal plan: ${JSON.stringify(plan)}\n\nFeedback: ${feedback}`,
            },
        ];
        const response = await this.provider.generate(messages, { temperature: 0.3 });
        try {
            return JSON.parse(response.content);
        }
        catch {
            return plan;
        }
    }
}
//# sourceMappingURL=planner.js.map