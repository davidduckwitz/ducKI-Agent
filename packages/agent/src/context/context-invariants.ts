import type { LLMMessage } from "@ducki/shared";

/** Reapply invariants after the final per-request window, not just after summarization. */
export function restoreContextInvariants(all: LLMMessage[], selected: Map<number, LLMMessage>, preserveUser: boolean): LLMMessage[] {
  const kept = new Map(selected);
  if (preserveUser) all.forEach((m, i) => {
    const meta = typeof m.metadata === "object" && m.metadata !== null ? m.metadata : {};
    if (m.role === "user" && !meta.runtimeContext && !meta.contextSummary && !meta.workingState) {
      // Selected original user messages must not be prefix-truncated by the window builder.
      // Old coding scaffolds can be reduced to the real user text when no longer selected.
      kept.set(i, !selected.has(i) && typeof meta.originalUserText === "string"
        ? { ...m, content: meta.originalUserText } : m);
    }
  });
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  all.forEach((m, i) => {
    for (const call of m.toolCalls ?? []) calls.set(call.id, i);
    if (m.role === "tool" && m.toolCallId) results.set(m.toolCallId, i);
  });
  for (const m of [...kept.values()]) {
    if (m.role === "tool" && m.toolCallId) {
      const index = calls.get(m.toolCallId);
      if (index !== undefined && !kept.has(index)) kept.set(index, { ...all[index]!, content: "[Earlier tool call]" });
    }
  }
  for (const m of [...kept.values()]) {
    for (const call of m.toolCalls ?? []) {
      const index = results.get(call.id);
      if (index !== undefined && !kept.has(index)) kept.set(index, {
        ...all[index]!, content: "[Earlier result outside context window. Re-read source if needed.]",
      });
    }
  }
  return [...kept].sort(([a], [b]) => a - b).map(([, m]) => m);
}
