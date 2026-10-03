import { AsyncLocalStorage } from "node:async_hooks";
import type { GenerateOptions, ReasoningEffort } from "@ducki/shared";

// A run may share providers with other conversations. Never mutate provider defaults:
// async context also reaches planner, compression, retries and coding sub-agents.
const reasoningContext = new AsyncLocalStorage<ReasoningEffort>();

export function withReasoningEffort<T>(effort: ReasoningEffort | undefined, run: () => T): T {
  return effort === undefined ? run() : reasoningContext.run(effort, run);
}

export function resolveReasoningEffort(options: GenerateOptions): ReasoningEffort | undefined {
  return reasoningContext.getStore() ?? options.reasoningEffort;
}

// SDK 4.x only types low/medium/high. The wire API also accepts none/xhigh;
// retain those fields without pretending the old SDK's enum is up to date.
export function openAIReasoningOptions(provider: string, model: string, options: GenerateOptions): Record<string, unknown> {
  const effort = resolveReasoningEffort(options);
  if (effort === undefined) return {};
  if (provider === "openrouter") {
    return { reasoning: effort === "off" ? { enabled: false } : { effort } };
  }
  return {
    reasoning_effort: effort === "off" ? "none" : effort,
    // OpenAI reasoning models use completion tokens and restrict sampling controls.
    ...(provider === "openai" && /^(?:o[134](?:-|$)|gpt-[5-9])/.test(model) ? {
      max_tokens: undefined,
      max_completion_tokens: options.maxTokens,
      temperature: undefined,
      top_p: undefined,
      frequency_penalty: undefined,
      presence_penalty: undefined,
    } : {}),
  };
}

export function claudeReasoningOptions(model: string, options: GenerateOptions): Record<string, unknown> {
  const effort = resolveReasoningEffort(options);
  if (effort === undefined) return {};
  // Claude 2 / 3.x (except 3.7) have no extended thinking and reject the parameter with a 400.
  // The effort is ambient (AsyncLocalStorage), so it also reaches sub-agents that run on such
  // an older model - they must simply run without it.
  if (/claude-(?:instant|2|3-(?:5-)?(?:opus|sonnet|haiku))/.test(model)) return {};
  if (effort === "off") return { thinking: { type: "disabled" } };
  if (/claude-(?:(?:opus|sonnet)-(?:4-[6-9]|[5-9])|(?:fable|mythos)-5)/.test(model)) {
    return {
      thinking: { type: "adaptive" },
      output_config: { effort: effort === "xhigh" && /-4-6/.test(model) ? "max" : effort },
      temperature: undefined,
    };
  }
  const budget = { low: 1024, medium: 4096, high: 8192, xhigh: 16384 }[effort];
  return {
    thinking: { type: "enabled", budget_tokens: budget },
    max_tokens: Math.max(options.maxTokens ?? 4000, budget + 1024),
    temperature: undefined,
  };
}
