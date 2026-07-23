import type { LLMProvider } from "@ducki/providers";
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
export declare class Planner {
    private readonly provider;
    private readonly logger;
    constructor(provider: LLMProvider, logger: Logger);
    createPlan(goal: string, availableTools?: string[]): Promise<Plan>;
    refinePlan(plan: Plan, feedback: string): Promise<Plan>;
}
//# sourceMappingURL=planner.d.ts.map