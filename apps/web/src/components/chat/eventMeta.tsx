import { Activity, BrainCircuit, GitBranch, Sparkles, Wrench, Monitor } from "lucide-react";
import type { AgentEventType } from "./chatTypes";

export function eventIcon(eventType?: AgentEventType) {
  if (eventType === "plan") return <GitBranch className="w-4 h-4 text-indigo-300" />;
  if (eventType === "tool_call" || eventType === "tool_result") return <Wrench className="w-4 h-4 text-amber-300" />;
  if (eventType === "iteration") return <Activity className="w-4 h-4 text-blue-300" />;
  if (eventType === "decision" || eventType === "guardrail") return <BrainCircuit className="w-4 h-4 text-emerald-300" />;
  if (eventType === "mode_selected") return <Sparkles className="w-4 h-4 text-fuchsia-300" />;
  if (eventType === "browser_preview") return <Monitor className="w-4 h-4 text-cyan-300" />;
  return <BrainCircuit className="w-4 h-4 text-purple-300" />;
}

export function eventLabel(t: (key: string) => string, eventType?: AgentEventType) {
  if (eventType === "plan") return t("chat.eventPlan");
  if (eventType === "tool_call") return t("chat.eventToolCall");
  if (eventType === "tool_result") return t("chat.eventToolResult");
  if (eventType === "iteration") return t("chat.eventIteration");
  if (eventType === "decision") return t("chat.eventDecision");
  if (eventType === "guardrail") return t("chat.eventGuardrail");
  if (eventType === "mode_selected") return t("chat.eventModeSelected");
  if (eventType === "browser_preview") return t("chat.eventBrowserPreview");
  return t("chat.eventReasoning");
}

const INTERNAL_TEXT_FIELDS = ["thinking", "preview", "response", "responsePreview"] as const;

/**
 * Reasoning/decision events carry a slice of the agent's internal LLM output
 * (e.g. reasoner "thinking", the raw response preview). Pull that out so it
 * renders as readable text instead of being buried in the raw JSON dump.
 */
export function extractInternalLlmText(eventData?: Record<string, unknown>): string | undefined {
  if (!eventData) return undefined;
  for (const field of INTERNAL_TEXT_FIELDS) {
    const value = eventData[field];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

export function eventDataWithoutInternalText(eventData?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!eventData) return undefined;
  const rest: Record<string, unknown> = {};
  let removedAny = false;
  for (const [key, value] of Object.entries(eventData)) {
    if ((INTERNAL_TEXT_FIELDS as readonly string[]).includes(key)) {
      removedAny = true;
      continue;
    }
    rest[key] = value;
  }
  if (!removedAny) return eventData;
  return Object.keys(rest).length > 0 ? rest : undefined;
}
