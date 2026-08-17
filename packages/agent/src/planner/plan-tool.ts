import type { LLMProvider } from "@ducki/providers";
import type { ToolExecutor, ToolResult } from "@ducki/shared";
import type { Logger } from "@ducki/logger";
import { Planner, type Plan } from "./planner.js";

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

const COMPLEXITY_LABEL: Record<string, string> = {
  low: "Niedrig",
  medium: "Mittel",
  high: "Hoch",
};

/** 1-5 scale the plan panel renders as dots. Kept next to COMPLEXITY_LABEL so the
 *  textual and numeric representations of a complexity can never drift apart. */
const COMPLEXITY_SCORE: Record<string, number> = {
  low: 1,
  medium: 3,
  high: 5,
};

/** Structured plan payload for the UI's plan panel. Emitted alongside the markdown so
 *  the frontend never has to re-parse rendered markdown to recover the steps it needs
 *  for display and execution. */
export interface PlanEventPayload {
  source: "plan_mode";
  goal: string;
  title: string;
  /** "coding" = software/implementation plan, "general" = non-code task plan. Lets the UI
   *  label the plan and the executor decide whether to route it to the coding agent. */
  planType?: "coding" | "general";
  complexity: number;
  complexityScore?: number;
  stepCount: number;
  executionStrategy?: "sequential" | "parallel" | "hybrid";
  overallRiskLevel?: "low" | "medium" | "high";
  totalEstimatedTokens?: number;
  totalEstimatedCostUsd?: number;
  downgradeSuggestion?: string;
  steps: Array<{
    id: string;
    title: string;
    description: string;
    tools?: string[];
    priority?: string;
    duration?: number;
    riskLevel?: "low" | "medium" | "high";
    estimatedTokens?: number;
    estimatedCostUsd?: number;
    parallelizable?: string[];
    subtasks?: Array<{ id: string; title: string; description: string; tools?: string[] }>;
  }>;
  validationIssues?: string[];
  markdown: string;
}

export function toPlanEventPayload(plan: Plan, markdown: string): PlanEventPayload {
  return {
    source: "plan_mode",
    goal: plan.goal,
    title: `Plan: ${plan.goal}`,
    ...(plan.planType ? { planType: plan.planType } : {}),
    complexity: COMPLEXITY_SCORE[plan.estimatedComplexity] ?? 3,
    complexityScore: plan.estimatedComplexityScore,
    stepCount: plan.steps.length,
    executionStrategy: plan.executionStrategy,
    ...(plan.overallRiskLevel ? { overallRiskLevel: plan.overallRiskLevel } : {}),
    ...(typeof plan.totalEstimatedTokens === "number" ? { totalEstimatedTokens: plan.totalEstimatedTokens } : {}),
    ...(typeof plan.totalEstimatedCostUsd === "number" ? { totalEstimatedCostUsd: plan.totalEstimatedCostUsd } : {}),
    ...(plan.downgradeSuggestion ? { downgradeSuggestion: plan.downgradeSuggestion } : {}),
    steps: plan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
      ...(step.toolsNeeded?.length ? { tools: step.toolsNeeded } : {}),
      priority: step.priority,
      duration: step.estimatedDuration,
      ...(step.riskLevel ? { riskLevel: step.riskLevel } : {}),
      ...(typeof step.estimatedTokens === "number" ? { estimatedTokens: step.estimatedTokens } : {}),
      ...(typeof step.estimatedCostUsd === "number" ? { estimatedCostUsd: step.estimatedCostUsd } : {}),
      ...(step.canParallelizeWith?.length ? { parallelizable: step.canParallelizeWith } : {}),
      ...(step.subtasks?.length ? {
        subtasks: step.subtasks.map((sub) => ({
          id: sub.id,
          title: sub.title,
          description: sub.description,
          ...(sub.toolsNeeded?.length ? { tools: sub.toolsNeeded } : {}),
        })),
      } : {}),
    })),
    validationIssues: plan.validationResult?.issues,
    markdown,
  };
}

/** Renders a Plan as markdown for display in chat - shared by the standalone "plan" tool
 *  and the agentMode:"plan" run-loop short-circuit so both surfaces stay in sync. */
export function formatPlanAsMarkdown(plan: Plan): string {
  const lines: string[] = [
    `## Plan: ${plan.goal}`,
    "",
  ];

  // Add header info
  if (plan.planType) {
    lines.push(`**Plan-Typ:** ${plan.planType === "coding" ? "Coding" : "Allgemein"}`);
  }
  lines.push(`**Geschaetzte Komplexitaet:** ${COMPLEXITY_LABEL[plan.estimatedComplexity] ?? plan.estimatedComplexity}`);
  if (plan.estimatedComplexityScore) {
    lines.push(`**Komplexitaets-Punktzahl:** ${plan.estimatedComplexityScore}/5`);
  }
  if (plan.totalSteps) {
    lines.push(`**Gesamt-Schritte:** ${plan.totalSteps}`);
  }
  if (plan.executionStrategy) {
    lines.push(`**Ausführungs-Strategie:** ${plan.executionStrategy}`);
  }
  if (plan.overallRiskLevel) {
    const riskLabel = { low: "Niedrig", medium: "Mittel", high: "Hoch" }[plan.overallRiskLevel];
    lines.push(`**Gesamt-Risiko:** ${riskLabel}`);
  }
  if (typeof plan.totalEstimatedCostUsd === "number") {
    lines.push(`**Geschätzte Kosten:** ${plan.totalEstimatedCostUsd.toFixed(4)} USD${plan.totalEstimatedTokens ? ` (~${plan.totalEstimatedTokens} Tokens)` : ""}`);
  } else if (typeof plan.totalEstimatedTokens === "number") {
    lines.push(`**Geschätzte Tokens:** ~${plan.totalEstimatedTokens}`);
  }
  lines.push("");

  if (plan.downgradeSuggestion) {
    lines.push(`💸 **Budget-Hinweis:** ${plan.downgradeSuggestion}`);
    lines.push("");
  }

  // Add validation issues if any
  if (plan.validationResult?.issues?.length) {
    lines.push("⚠️ **Validierungsprobleme:**");
    plan.validationResult.issues.forEach((issue) => {
      lines.push(`- ${issue}`);
    });
    lines.push("");
  }

  // Add steps with detailed info. A checkbox is only shown once a step has left "pending"
  // (i.e. this markdown reflects real execution progress, e.g. EXECUTION_MODE_UPDATE_PLAN_FILE
  // re-saving the plan mid/post-execution) - a freshly created plan's steps are all
  // "pending" and render exactly as before (no visible checkbox noise).
  plan.steps.forEach((step, index) => {
    const checkbox =
      step.status === "completed" ? "[x] " : step.status === "failed" ? "[!] " : step.status === "running" ? "[~] " : "";
    lines.push(`${index + 1}. ${checkbox}**${step.title}**`);
    if (step.description) lines.push(`   ${step.description}`);

    const metadata: string[] = [];
    if (step.priority) metadata.push(`Priority: ${step.priority}`);
    if (step.estimatedDuration) {
      const mins = Math.round(step.estimatedDuration / 60);
      metadata.push(`Est. ${mins}min`);
    }
    if (step.riskLevel && step.riskLevel !== "low") {
      metadata.push(`Risk: ${step.riskLevel}`);
    }
    if (typeof step.estimatedCostUsd === "number" && step.estimatedCostUsd > 0) {
      metadata.push(`~$${step.estimatedCostUsd.toFixed(4)}`);
    }
    if (metadata.length) {
      lines.push(`   _${metadata.join(" | ")}_`);
    }

    if (step.toolsNeeded?.length) {
      lines.push(`   _Benoetigte Tools: ${step.toolsNeeded.join(", ")}_`);
    }
    if (step.dependsOn?.length) {
      lines.push(`   _Abhaengig von: ${step.dependsOn.join(", ")}_`);
    }
    if (step.canParallelizeWith?.length) {
      lines.push(`   ✓ Kann parallel laufen mit: ${step.canParallelizeWith.join(", ")}`);
    }

    // Add subtasks if any
    if (step.subtasks?.length) {
      lines.push(`   **Untertasks:**`);
      step.subtasks.forEach((sub, subIdx) => {
        lines.push(`   ${index + 1}.${String.fromCharCode(97 + subIdx)}) ${sub.title}`);
        if (sub.description) lines.push(`      ${sub.description}`);
        if (sub.toolsNeeded?.length) {
          lines.push(`      _Tools: ${sub.toolsNeeded.join(", ")}_`);
        }
      });
    }
    lines.push("");
  });

  lines.push("_Dies ist nur ein Plan - es wurde noch nichts ausgefuehrt._");
  return lines.join("\n");
}

/**
 * Standalone "plan" tool: lets the agent switch into planning-only mode mid-run to
 * produce a structured plan (goal, steps, complexity) via the same Planner used for
 * full-mode auto-planning, without executing any of the steps or other tools. This is
 * the tool-call surface for plan mode; the agentMode:"plan" run-loop short-circuit in
 * agent.ts is the whole-turn surface - both share formatPlanAsMarkdown/Planner so a
 * plan looks the same regardless of which path produced it.
 *
 * Takes a provider getter (not a provider instance) to mirror createScriptTools' pattern:
 * the tool always uses whichever provider is currently configured, not a snapshot taken
 * at agent-construction time.
 */
export function createPlanTool(getProvider: () => LLMProvider, logger: Logger): ToolExecutor {
  return {
    name: "plan",
    description:
      "Create or refine a structured step-by-step plan WITHOUT executing it. Use when the user asks to plan, outline, or scope work before doing it, or when a task is complex enough to lay out first.",
    definition: {
      name: "plan",
      description: "Planning-only tool: returns a structured plan (goal, steps, complexity) and performs no side effects.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "refine"], description: "create a new plan or refine an existing one" },
          goal: { type: "string", description: "The goal/task to plan for (required for action=create)" },
          availableTools: { type: "array", items: { type: "string" }, description: "Optional tool names to consider when scoping steps" },
          plan: { description: "Existing plan object to refine (required for action=refine)" },
          feedback: { type: "string", description: "Feedback to refine the plan with (required for action=refine)" },
        },
        required: ["action"],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const rawAction = String(input["action"] ?? "create").toLowerCase();
      const action = rawAction === "refine" ? "refine" : "create";
      const planner = new Planner(getProvider(), logger);

      try {
        if (action === "refine") {
          const existingPlan = input["plan"];
          const feedback = String(input["feedback"] ?? "").trim();
          if (!existingPlan || typeof existingPlan !== "object") {
            return fail("plan:refine requires field 'plan' (the existing plan object returned by plan:create)");
          }
          if (!feedback) return fail("plan:refine requires field 'feedback'");

          const refined = await planner.refinePlan(existingPlan as Plan, feedback);
          return ok({ plan: refined, markdown: formatPlanAsMarkdown(refined) });
        }

        const goal = String(input["goal"] ?? "").trim();
        if (!goal) return fail("plan:create requires field 'goal'");
        const availableTools = Array.isArray(input["availableTools"])
          ? (input["availableTools"] as unknown[]).map(String)
          : [];

        const plan = await planner.createPlan(goal, availableTools);
        return ok({ plan, markdown: formatPlanAsMarkdown(plan) });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
