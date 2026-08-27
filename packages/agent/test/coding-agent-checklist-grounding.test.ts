import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * The checklist is otherwise entirely self-reported: the model calls todo:update(done) and
 * nothing checks whether it actually wrote anything. This pins the grounding check added to
 * CodingAgent.run() - a step marked "done" in an attempt whose checkpoint diff shows zero
 * changed files must be demoted back to "in_progress" rather than trusted at face value.
 */
function stubDb() {
  let nextId = 1;
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
    createConversation: async (data: { name: string }) => ({ id: nextId++, name: data.name }),
  };
  return new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as any;
}

function scriptedProvider(contents: string[]) {
  let index = 0;
  const next = () => {
    const content = contents[Math.min(index, contents.length - 1)] ?? "Fertig.";
    index++;
    return {
      content,
      model: "test-model",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    };
  };
  return {
    model: "test-model",
    generate: async () => next(),
    generateStream: async () => next(),
    supportsStreaming: () => false,
  } as any;
}

const PLAN_JSON = JSON.stringify({
  goal: "add a health endpoint",
  planType: "coding",
  estimatedComplexity: "low",
  steps: [{ id: "step_1", title: "Add the endpoint", description: "..." }],
});

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
});

const TWO_STEP_PLAN_JSON = JSON.stringify({
  goal: "add two endpoints",
  planType: "coding",
  estimatedComplexity: "low",
  steps: [
    { id: "step_1", title: "Add the health endpoint", description: "..." },
    { id: "step_2", title: "Add the status endpoint", description: "..." },
  ],
});

describe("CodingAgent checklist grounding against the checkpoint diff", () => {
  it("demotes a step marked done when the attempt changed no files", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-cp-ground-"));
    sandboxes.push(sandbox);
    // Marks the only step "done" without ever calling the filesystem tool.
    const provider = scriptedProvider([PLAN_JSON, "[TOOL:todo action=update id=1 status=done]", "Fertig."]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("add a health endpoint", { maxAttempts: 1 });

    const todos = (codingAgent as any).todos.snapshot();
    expect(todos).toHaveLength(1);
    expect(todos[0].status).toBe("in_progress");
    expect(todos[0].note).toContain("Checkpoint-Diff");
    expect(result.success).toBe(false);
    expect(result.completionStatus).toBe("incomplete");
    expect(result.completionEvidence).toMatchObject({
      mutationExpected: true,
      fileChangesObserved: false,
    });
  });

  it("keeps a step marked done when the attempt actually wrote a file", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-cp-ground-ok-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      PLAN_JSON,
      "[TOOL:filesystem action=write path=app.js]\ncontent\n[/TOOL]",
      "[TOOL:todo action=update id=1 status=done]",
      "Fertig.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    await codingAgent.run("add a health endpoint", { maxAttempts: 1 });

    const todos = (codingAgent as any).todos.snapshot();
    expect(todos).toHaveLength(1);
    expect(todos[0].status).toBe("done");
  });

  /**
   * Regression: a step demoted by grounding (this attempt's own "done" claim, with zero file
   * changes) used to still fall through to the terminal "unverified, no more attempts" branch
   * whenever anyFileChangedThisRun was false and the response text didn't happen to match the
   * "announced next step" pattern - ending the WHOLE run (success:true, verified:false) with
   * attempts left on the table and a checklist item that was JUST reopened one line earlier.
   * A legitimate no-file-change step (e.g. "reproduce the error" via a read-only tool) hit this
   * exact path. The demotion itself is real signal that the model is actively driving the
   * checklist, not evidence it should be abandoned - it must earn another attempt.
   */
  it("continues to another attempt after a same-attempt grounding demotion, instead of ending the run", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-cp-ground-continue-"));
    sandboxes.push(sandbox);
    // Attempt 1: marks the only step "done" without writing any file - gets demoted, and
    // (with maxAttempts:2) a second attempt should follow instead of the run ending here.
    const provider = scriptedProvider([
      PLAN_JSON,
      "[TOOL:todo action=update id=1 status=done]",
      "Fertig fuer diesen Versuch.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("add a health endpoint", { maxAttempts: 2 });

    // Ran a second attempt rather than stopping after the first - scriptedProvider clamps to
    // its last scripted content once exhausted, so `attempts` > 1 is the signal that matters.
    expect(result.attempts).toBeGreaterThan(1);
  });

  it("allows an explicitly read-only run to complete without inventing a mutation requirement", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-read-only-contract-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      PLAN_JSON,
      "[TOOL:todo action=update id=1 status=done]",
      "Review complete.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("review the health endpoint", {
      maxAttempts: 1,
      mutationExpected: false,
    });

    expect(result.success).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.completionStatus).toBe("completed_unverified");
    expect(result.completionEvidence).toMatchObject({
      mutationExpected: false,
      fileChangesObserved: false,
      openChecklistItems: [],
    });
  });

  /**
   * Regression: a plan made entirely of explore/inspect/diagnose-type steps (a pure analysis
   * task, no construction work planned or needed) used to be held to mutationExpected:true
   * anyway - the run was correctly executed but still ended up marked incomplete because no
   * file changed, which then fed back into the model as failure pressure it had no way to
   * satisfy. mutationExpected is now derived from the plan itself instead of hardcoded.
   */
  it("derives mutationExpected:false from a plan whose steps are all check/diagnostic work", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-cp-ground-analysis-"));
    sandboxes.push(sandbox);
    writeFileSync(join(sandbox, "index.html"), "<html></html>");
    const analysisPlan = JSON.stringify({
      goal: "debug the game",
      planType: "coding",
      estimatedComplexity: "low",
      steps: [
        { id: "step_1", title: "Explore repository structure to locate source files", description: "..." },
        { id: "step_2", title: "Inspect HTML for missing resource references", description: "..." },
      ],
    });
    const provider = scriptedProvider([
      analysisPlan,
      "[TOOL:filesystem action=read path=index.html]",
      "[TOOL:todo action=update id=1 status=done]",
      "[TOOL:todo action=update id=2 status=done]",
      "Analysis complete - found the issue.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("debug the game", { maxAttempts: 1 });

    expect(result.success).toBe(true);
    expect(result.completionEvidence).toMatchObject({ mutationExpected: false, fileChangesObserved: false });
    const todos = (codingAgent as any).todos.snapshot();
    expect(todos.every((t: { status: string }) => t.status === "done")).toBe(true);
  });

  /**
   * Regression: the old grounding check only asked "did ANY file change this attempt?" - with
   * two construction steps closed out in the same attempt, a single write covering step 1 was
   * enough to also confirm step 2, which never got its own change. Per-step attribution via
   * RunJournalEntry.stepId (the "current" todo item at the moment of a successful write) must
   * catch this: only the step actually being worked on when the write happened stays "done".
   */
  it("demotes only the step with no attributable write when two steps are closed in one attempt", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-cp-ground-batch-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      TWO_STEP_PLAN_JSON,
      "[TOOL:todo action=update id=1 status=in_progress]",
      "[TOOL:filesystem action=write path=health.js]\ncontent\n[/TOOL]",
      "[TOOL:todo action=update id=1 status=done]",
      "[TOOL:todo action=update id=2 status=done]",
      "Fertig.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    await codingAgent.run("add two endpoints", { maxAttempts: 1 });

    const todos = (codingAgent as any).todos.snapshot();
    const step1 = todos.find((t: any) => t.id === 1);
    const step2 = todos.find((t: any) => t.id === 2);
    expect(step1.status).toBe("done");
    expect(step2.status).toBe("in_progress");
    expect(step2.note).toContain("Journal");
  });

});
