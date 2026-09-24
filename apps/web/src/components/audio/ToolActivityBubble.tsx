import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useAppStore, type ToolCallRecord } from "../../lib/store";

function describeToolCall(call: ToolCallRecord): string {
  const input = call.input ?? {};
  if (call.toolName.toLowerCase() === "browser") {
    const url = typeof input["url"] === "string" ? (input["url"] as string) : undefined;
    const action = call.action || (typeof input["action"] === "string" ? (input["action"] as string) : undefined);
    if (url) return `Nutzt Browser: ${url}`;
    if (action) return `Nutzt Browser (${action})`;
    return "Nutzt Browser";
  }
  const label = call.action ? `${call.toolName} (${call.action})` : call.toolName;
  return `Nutzt ${label}`;
}

/**
 * Floating pill above the voice orb showing what the agent is currently doing, driven by the
 * same global tool-call state ToolEventsDisplay already maintains (useAppStore) - no separate
 * socket subscription needed. Replaces the normal chat feed's inline tool-call rows for the
 * Audio tab, which hides its transcript (see ChatContainer's hideTranscript prop) in favor of
 * this transient overlay + spoken output.
 */
export function ToolActivityBubble() {
  const toolCalls = useAppStore((s) => s.toolCalls);
  const runningTools = useAppStore((s) => s.runningTools);
  const [lastCompleted, setLastCompleted] = useState<ToolCallRecord | null>(null);

  const executing = [...toolCalls].reverse().find((c) => c.status === "executing" && runningTools.has(c.toolName));

  useEffect(() => {
    if (executing) return;
    const mostRecent = [...toolCalls].reverse().find((c) => c.status === "completed" || c.status === "failed");
    if (!mostRecent) return;
    setLastCompleted(mostRecent);
    const timer = setTimeout(() => setLastCompleted(null), 2500);
    return () => clearTimeout(timer);
    // Only re-run when the running set drains, not on every toolCalls mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningTools]);

  const shown = executing ?? lastCompleted;
  if (!shown) return null;

  const done = shown.status !== "executing";

  return (
    <div
      className={`flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium shadow-lg backdrop-blur transition-opacity ${
        done
          ? "border-emerald-500/40 bg-emerald-950/70 text-emerald-200"
          : "border-indigo-500/40 bg-indigo-950/70 text-indigo-200"
      }`}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      <span className="max-w-xs truncate">{describeToolCall(shown)}</span>
    </div>
  );
}
