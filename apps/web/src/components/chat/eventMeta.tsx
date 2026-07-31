import { Activity, AlertTriangle, BrainCircuit, Check, GitBranch, Sparkles, Wrench, Monitor, Zap, RefreshCw } from "lucide-react";
import type { AgentEventType } from "./chatTypes";

export function eventIcon(eventType?: AgentEventType, eventData?: Record<string, unknown>) {
  if (eventType === "tool_result") {
    const success = eventData?.["success"];
    if (success === false) return <AlertTriangle className="w-4 h-4 text-red-300" />;
    if (success === true) return <Check className="w-4 h-4 text-emerald-300" />;
  }
  if (eventType === "plan") return <GitBranch className="w-4 h-4 text-indigo-300" />;
  if (eventType === "tool_call" || eventType === "tool_result") return <Wrench className="w-4 h-4 text-amber-300" />;
  if (eventType === "skill_selection") return <Zap className="w-4 h-4 text-cyan-300 animate-pulse" />;
  if (eventType === "tool_retry") return <RefreshCw className="w-4 h-4 text-orange-300" />;
  if (eventType === "iteration") return <Activity className="w-4 h-4 text-blue-300" />;
  if (eventType === "decision" || eventType === "guardrail") return <BrainCircuit className="w-4 h-4 text-emerald-300" />;
  if (eventType === "mode_selected") return <Sparkles className="w-4 h-4 text-fuchsia-300" />;
  if (eventType === "browser_preview") return <Monitor className="w-4 h-4 text-cyan-300" />;
  return <BrainCircuit className="w-4 h-4 text-purple-300" />;
}

/**
 * Colour per event kind. Everything used to render in the same indigo box, so a failed
 * tool call looked exactly like a successful one and the eye had no way to find the
 * interesting line in a long run.
 */
export function eventTone(eventType?: AgentEventType, eventData?: Record<string, unknown>): string {
  if (eventType === "tool_result" && eventData?.["success"] === false) {
    return "border-red-500/40 bg-red-500/10 text-red-100";
  }
  if (eventType === "skill_selection") return "border-cyan-500/30 bg-cyan-500/[0.07] text-cyan-100";
  if (eventType === "tool_retry") return "border-orange-500/40 bg-orange-500/10 text-orange-100";
  if (eventType === "guardrail") return "border-orange-500/40 bg-orange-500/10 text-orange-100";
  if (eventType === "tool_call") return "border-amber-500/30 bg-amber-500/[0.07] text-amber-100";
  if (eventType === "tool_result") return "border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-100";
  if (eventType === "plan") return "border-indigo-500/30 bg-indigo-500/10 text-indigo-100";
  return "border-gray-600/40 bg-gray-500/[0.07] text-gray-300";
}

export function eventLabel(t: (key: string) => string, eventType?: AgentEventType) {
  if (eventType === "plan") return t("chat.eventPlan");
  if (eventType === "tool_call") return t("chat.eventToolCall");
  if (eventType === "tool_result") return t("chat.eventToolResult");
  if (eventType === "skill_selection") return "Skills Selected";
  if (eventType === "tool_retry") return "Tool Retry";
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
