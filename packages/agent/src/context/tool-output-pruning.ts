import type { LLMMessage } from "@ducki/shared";

/** Tool outputs up to this size are never pruned from a coding run's context - too small to matter. */
export const PRUNABLE_TOOL_OUTPUT_CHARS = 2000;

/** Fraction of the protected budget the cut drops back to once the budget is exceeded. */
const PRUNE_SLACK_RATIO = 0.6;

function isPrunableToolOutput(message: LLMMessage | undefined): boolean {
  return message?.role === "tool" && typeof message.content === "string" && message.content.length > PRUNABLE_TOOL_OUTPUT_CHARS;
}

/**
 * Where opencode-style tool-output pruning currently cuts: large tool outputs in messages at an
 * index BELOW the returned value are replaced by a short note.
 *
 * Walks newest-first and sums large tool outputs. The cut only advances once that sum exceeds
 * `protectChars` for an output not yet pruned, and then jumps to where the sum passed 60% of the
 * budget - so pruning happens in rare batches. A cut that moved a little on every iteration would
 * change an old message each time and invalidate the provider's cached history prefix on every
 * single call. The cut never moves backwards (pass the previous value as `currentCut`).
 */
export function computeToolPruneCut(messages: LLMMessage[], protectChars: number, currentCut: number): number {
  let cumulative = 0;
  let slackIndex = -1;
  let overIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isPrunableToolOutput(message)) continue;
    cumulative += (message!.content as string).length;
    if (slackIndex < 0 && cumulative > protectChars * PRUNE_SLACK_RATIO) slackIndex = i;
    if (cumulative > protectChars) {
      overIndex = i;
      break;
    }
  }
  const cut = overIndex >= currentCut ? slackIndex + 1 : currentCut;
  return Math.min(cut, messages.length);
}

/** The replacement a pruned tool output gets, or undefined when the message stays verbatim. */
export function prunedToolOutput(message: LLMMessage, index: number, cut: number): string | undefined {
  if (index >= cut || !isPrunableToolOutput(message)) return undefined;
  return (
    `[Old tool output pruned to save context (${(message.content as string).length} chars). ` +
    "If you still need it, run the tool again - files may have changed since.]"
  );
}
