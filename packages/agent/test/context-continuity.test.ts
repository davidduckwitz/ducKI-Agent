import { describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "@ducki/shared";
import { TieredContextCompressor, safeContextBoundary } from "../src/context/tiered-compressor.js";
import { ConversationCompressor } from "../src/conversation/compressor.js";
import { restoreContextInvariants } from "../src/context/context-invariants.js";

const provider = () => ({ generate: vi.fn(async () => ({ content: '{"summary":"facts", "keyDecisions":[]}' })) }) as any;
const pair = (id: string): LLMMessage[] => [
  { role: "assistant", content: "read source", toolCalls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }] },
  { role: "tool", toolCallId: id, content: "a".repeat(3000) + "\nerror TS2322: tail evidence" },
];
describe("coding context continuity", () => {
  it("restores user restrictions and full tool pairs after the final request window", () => {
    const all = [{ role: "user" as const, content: "Never touch auth.ts" }, ...pair("a"), ...pair("b")];
    const out = restoreContextInvariants(all, new Map([[4, all[4]!]]), true);
    expect(out).toContainEqual(all[0]);
    expect(out.some(m => m.toolCalls?.some(call => call.id === "b"))).toBe(true);
    expect(out.find(m => m.toolCallId === "b")?.content).toContain("tail evidence");
  });
  it("light pruning saves tokens without removing tool results or their error tail", async () => {
    const model = provider();
    const compressor = new TieredContextCompressor(model, { modelName: "claude-sonnet-5", thresholds: [0, 99, 100], preserveRecentCount: 1 });
    const messages = [...pair("a"), ...pair("b"), { role: "user" as const, content: "continue" }];
    const out = await compressor.compress(messages);
    expect(out.decision.tokensSaved).toBeGreaterThan(0);
    expect(out.messages.filter(m => m.role === "tool").map(m => m.toolCallId)).toEqual(["a", "b"]);
    expect(out.messages[1]!.content).toContain("error TS2322: tail evidence");
    expect(model.generate).not.toHaveBeenCalled();
    expect(messages[1]!.content).toEqual(pair("a")[1]!.content);
  });
  it("moves a recent-window cut before its corresponding native call", () => {
    expect(safeContextBoundary([{ role: "user", content: "goal" }, ...pair("a")], 2)).toBe(1);
  });
  it("preserves constraints and completed todos after repeated emergency compression", async () => {
    const model = provider();
    const compressor = new TieredContextCompressor(model, { modelName: "claude-sonnet-5", thresholds: [0, 0, 0], emergencyKeepCount: 1 });
    const rule: LLMMessage = { role: "user", content: "Never modify the database schema." };
    const messages = [rule, ...pair("a"), ...pair("b")];
    const state = JSON.stringify({ goal: "repair UI", checklist: [{ title: "UI", status: "done" }], nextStep: "verify" });
    const first = await compressor.compress(messages, state);
    const second = await compressor.compress([...first.messages, ...pair("c")], state);
    expect(second.messages).toContainEqual(rule);
    expect(second.messages.filter(m => typeof m.metadata === "object" && m.metadata?.workingState)).toHaveLength(1);
    expect(second.messages.at(-1)?.content).toContain('"status":"done"');
    const toolIds = new Set(second.messages.filter(m => m.role === "tool").map(m => m.toolCallId));
    for (const m of second.messages) for (const call of m.toolCalls ?? []) expect(toolIds.has(call.id)).toBe(true);
  });
  it("reports pressure rather than erasing a large user constraint", async () => {
    const compressor = new TieredContextCompressor(provider(), { modelName: "unknown-model", thresholds: [0, 0, 0] });
    const message: LLMMessage = { role: "user", content: "Do not change this: " + "x ".repeat(100000) };
    const out = await compressor.compress([message]);
    expect(out.messages).toContainEqual(message);
    expect(out.decision.usageAfter).toBeGreaterThan(0);
  });
  it("passes the end of long evidence to summarization, including later records", async () => {
    const model = provider();
    const compressor = new TieredContextCompressor(model, { modelName: "claude-sonnet-5", thresholds: [0, 0, 100] });
    const messages: LLMMessage[] = Array.from({ length: 15 }, (_, i) => ({ role: "assistant", content: "a".repeat(3000) + `TAIL_${i}` }));
    await compressor.compress(messages);
    const sent = JSON.stringify(model.generate.mock.calls);
    expect(sent).toContain("TAIL_0");
    expect(sent).toContain("TAIL_9");
  });
});
describe("legacy summary boundaries and identity", () => {
  it("invalidates same-index summaries when contents or native calls change", async () => {
    const model = provider();
    const compressor = new ConversationCompressor(model);
    await compressor.summarizeRange([{ role: "user", content: "first" }], 0, 0);
    await compressor.summarizeRange([{ role: "user", content: "second" }], 0, 0);
    await compressor.summarizeRange([{ role: "user", content: "second" }], 0, 0);
    expect(model.generate).toHaveBeenCalledTimes(2);
    compressor.clearCache(0, 0);
    expect(compressor.getCachedSummaries()).toEqual([]);
  });
  it("summarizes non-overlapping chunks without entering the recent window", async () => {
    const compressor = new ConversationCompressor(provider());
    const messages: LLMMessage[] = Array.from({ length: 125 }, (_, i) => ({ role: "user", content: `message ${i}` }));
    const result = await compressor.buildCompressedContext(messages, 20);
    expect(result.summaries.map(s => [s.messageRangeStart, s.messageRangeEnd])).toEqual([[0, 49], [50, 99], [100, 104]]);
    expect(result.recentMessages).toEqual(messages.slice(105));
  });
});
