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

/** Renders a Plan as markdown for display in chat - shared by the standalone "plan" tool
 *  and the agentMode:"plan" run-loop short-circuit so both surfaces stay in sync. */
export function formatPlanAsMarkdown(plan: Plan): string {
  const lines: string[] = [
    `## Plan: ${plan.goal}`,
    "",
    `**Geschaetzte Komplexitaet:** ${COMPLEXITY_LABEL[plan.estimatedComplexity] ?? plan.estimatedComplexity}`,
    "",
  ];

  plan.steps.forEach((step, index) => {
    lines.push(`${index + 1}. **${step.title}**`);
    if (step.description) lines.push(`   ${step.description}`);
    if (step.toolsNeeded?.length) lines.push(`   _Benoetigte Tools: ${step.toolsNeeded.join(", ")}_`);
    if (step.dependsOn?.length) lines.push(`   _Abhaengig von: ${step.dependsOn.join(", ")}_`);
  });

  lines.push("", "_Dies ist nur ein Plan - es wurde noch nichts ausgefuehrt._");
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
