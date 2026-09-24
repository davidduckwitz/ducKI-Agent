import { BrainCircuit } from "lucide-react";
import { isReasoningEffort, REASONING_EFFORTS } from "@ducki/shared/reasoning";
import { useAppStore } from "../../lib/store";

/** Shared by normal/audio chat and the coding composer, like the model selection. */
export function ReasoningSelector() {
  const effort = useAppStore((state) => state.reasoningEffort);
  const setEffort = useAppStore((state) => state.setReasoningEffort);
  return (
    <label
      className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground"
      title="Thinking / Reasoning für die nächste Nachricht. Unterstützte Stufen hängen vom Modell ab."
      onClick={(event) => event.stopPropagation()}
    >
      <BrainCircuit className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">Thinking</span>
      <select
        aria-label="Thinking / Reasoning"
        value={effort ?? ""}
        onChange={(event) => setEffort(isReasoningEffort(event.target.value) ? event.target.value : undefined)}
        className="min-w-0 rounded border border-border bg-card px-1 py-1 text-xs text-foreground focus-visible:outline-primary"
      >
        <option value="">Standard</option>
        {REASONING_EFFORTS.map((value) => <option key={value} value={value}>{value === "off" ? "Aus" : value}</option>)}
      </select>
    </label>
  );
}
