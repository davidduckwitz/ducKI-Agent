import { describe, expect, it } from "vitest";
import type { LLMMessage } from "@ducki/shared";
import { computeToolPruneCut, prunedToolOutput } from "../src/context/tool-output-pruning";

const tool = (chars: number): LLMMessage => ({ role: "tool", toolCallId: "x", content: "a".repeat(chars) });
const assistant: LLMMessage = { role: "assistant", content: "thinking about it" };

describe("tool-output pruning for coding runs", () => {
  it("prunes nothing while the large outputs fit the protected budget", () => {
    const messages = [tool(3000), assistant, tool(3000)];
    expect(computeToolPruneCut(messages, 10000, 0)).toBe(0);
  });

  it("cuts back to 60% of the budget once it is exceeded", () => {
    // newest-first sums: idx4=4000, idx2=8000 (> 6000 slack), idx0=12000 (> 10000 budget)
    const messages = [tool(4000), assistant, tool(4000), assistant, tool(4000)];
    const cut = computeToolPruneCut(messages, 10000, 0);
    expect(cut).toBe(3);
    expect(prunedToolOutput(messages[0]!, 0, cut)).toContain("pruned");
    expect(prunedToolOutput(messages[2]!, 2, cut)).toContain("pruned");
    expect(prunedToolOutput(messages[4]!, 4, cut)).toBeUndefined();
  });

  it("keeps the cut stable while new output still fits after a batch prune (cache-friendly)", () => {
    const messages = [tool(4000), assistant, tool(4000), assistant, tool(4000)];
    const first = computeToolPruneCut(messages, 10000, 0);
    const grown = [...messages, assistant, tool(3000)];
    // Only 7000 unpruned output newer than the cut - below the budget, so the cut must not move.
    expect(computeToolPruneCut(grown, 10000, first)).toBe(first);
  });

  it("never prunes small tool outputs or non-tool messages", () => {
    const small = tool(500);
    expect(prunedToolOutput(small, 0, 10)).toBeUndefined();
    expect(prunedToolOutput({ role: "user", content: "x".repeat(5000) }, 0, 10)).toBeUndefined();
  });
});
