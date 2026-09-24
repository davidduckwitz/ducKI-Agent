import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "../src/coding/coding-agent.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function db() {
  const rows: any[] = [];
  const known: Record<string, any> = {
    getAllSettings: async () => [], getSetting: async () => undefined,
    createConversation: async () => ({ id: 1 }), getMemories: async (_id: any, type: string) => rows.filter(r => r.type === type),
    addMemory: vi.fn(async (data: any) => { const row = { ...data, id: rows.length + 1 }; rows.push(row); return row; }),
    getEverUsedSkills: async () => [], getDynamicToolByName: async () => undefined,
  };
  return new Proxy(known, { get: (target, key: string) => key in target ? target[key] : async () => undefined }) as any;
}
describe("CodingAgent project learning integration", () => {
  it.each([true, false])("learns only after the controller verifies actual edits (memory=%s)", async enabled => {
    const root = await mkdtemp(join(tmpdir(), "ducki-learning-run-")); roots.push(root);
    const store = db();
    let turns = 0;
    const main = { model: "claude-sonnet-5", supportsStreaming: () => false,
      generate: vi.fn(async () => ({ usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, content: turns++ === 0
        ? '>> PHASE: EDIT\n[TOOL:filesystem action=write path=sample.js]\nexport const value = 1;\n[/TOOL]'
        : "Implemented sample.js and ready for verification." })) } as any;
    const learner = { generate: vi.fn(async () => ({ content: JSON.stringify({ trigger: "sample module",
      observation: "A named export is required by the sample consumer", action: "Keep the named value export",
      conditions: "When extending the sample consumer" }) })) } as any;
    const coding = new CodingAgent(main, store, undefined, { sandboxRoot: root, explorerProvider: learner });
    const inner = (coding as any).agent;
    const originalExecute = inner.executor.execute.bind(inner.executor);
    inner.executor.execute = async (name: string, input: any, options: any) => name === "shell"
      ? { success: true, data: { exitCode: 0 } } : originalExecute(name, input, options);
    const result = await coding.run("Create sample.js with a named value export", { projectLearning: enabled,
      existingPlan: { goal: "create sample", steps: [], estimatedComplexity: "low", planType: "coding" },
      verifyCommand: "node --check sample.js", maxAttempts: 1 });
    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(await readFile(join(root, "sample.js"), "utf8")).toContain("export const value");
    expect(learner.generate).toHaveBeenCalledTimes(enabled ? 1 : 0);
    if (enabled) expect(store.addMemory).toHaveBeenCalledWith(expect.objectContaining({ status: "pending", type: expect.stringContaining("coding-project:") }));
  }, 20000);
});
