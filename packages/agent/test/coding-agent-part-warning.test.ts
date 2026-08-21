import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * A parted write (write totalParts=N, then append partNumber=2..N) that is never finished
 * leaves an incomplete file on disk. The CodingAgent must not end silently then: its
 * end-of-run check first runs a bounded SELF-HEALING attempt that writes exactly the missing
 * parts; the warning (summary + decision event) is the fallback when healing does not finish
 * the job or the run was explicitly stopped.
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
    const content = contents[Math.min(index, contents.length - 1)] ?? "done";
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

const sandboxes: string[] = [];
afterEach(() => {
  for (const d of sandboxes) rmSync(d, { recursive: true, force: true });
  sandboxes.length = 0;
});

describe("CodingAgent incomplete part-sequence warning", () => {
  it("heals a missing part automatically: a follow-up run appends the missing part", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-part-"));
    sandboxes.push(sandbox);
    // Main run: part 1 of 2 written, then "Fertig.". Healing run (lightweight, no planning):
    // the append marker lands in its first response and completes the sequence.
    const provider = scriptedProvider([
      "[TOOL:filesystem action=write path=app.js totalParts=2]\npart1\n[/TOOL]",
      "Fertig.",
      "[TOOL:filesystem action=append path=app.js partNumber=2 totalParts=2]\npart2\n[/TOOL]",
      "Fertig.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("schreibe die Datei app.js", { maxAttempts: 1 });

    expect(result.summary).toContain("Self-Healing");
    expect(result.summary).toContain("nachgeschrieben");
    expect(result.summary).not.toContain("WARNUNG: Unvollstaendige Datei-Schreibsequenz");
    // Both parts are on disk after healing.
    expect(require("node:fs").readFileSync(join(sandbox, "app.js"), "utf8")).toBe("part1part2");
  });

  it("warns when a parted write is left incomplete at run end", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-part-"));
    sandboxes.push(sandbox);
    // Response 1 writes part 1 of 2; response 2 (the post-tool turn) finishes the run
    // without sending part 2 - the sequence stays incomplete.
    const provider = scriptedProvider([
      "[TOOL:filesystem action=write path=app.js totalParts=2]\npart1\n[/TOOL]",
      "Fertig.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    // Skip the redundant Agent-level planning phase so the scripted write lands in the run
    // loop's FIRST response (the coding agent's own prompt is already phase-based).
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("schreibe die Datei app.js", { maxAttempts: 1 });

    expect(result.summary).toContain("Unvollstaendige Datei-Schreibsequenz");
    expect(result.summary).toContain("auch nach dem automatischen Folge-Versuch");
    expect(result.summary).toContain("app.js");
    expect(result.summary).toContain("1/2 Teile");
    expect(result.summary).toContain("partNumber:2");
    // The first part really is on disk - only the second part is missing.
    expect(require("node:fs").readFileSync(join(sandbox, "app.js"), "utf8")).toBe("part1");
  });

  it("does not warn when the sequence was completed", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-part-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      "[TOOL:filesystem action=write path=app.js totalParts=2]\npart1\n[/TOOL]",
      "[TOOL:filesystem action=append path=app.js partNumber=2 totalParts=2]\npart2\n[/TOOL]",
      "Fertig.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("schreibe die Datei app.js", { maxAttempts: 1 });

    expect(result.summary).not.toContain("Unvollstaendige Datei-Schreibsequenz");
  });

  it("emits a decision event carrying the incomplete file details", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-part-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      "[TOOL:filesystem action=write path=app.js totalParts=2]\npart1\n[/TOOL]",
      "Fertig.",
    ]);
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const codingAgent = new CodingAgent(provider, stubDb(), {
      emitEvent: async (e: any) => events.push(e),
    } as any, { sandboxRoot: sandbox });
    (codingAgent as any).agent.enablePlanning = false;

    await codingAgent.run("schreibe die Datei app.js", { maxAttempts: 1 });

    const warning = events.find((e) => (e.data as any)?.part_warning === true);
    expect(warning).toBeDefined();
    expect((warning!.data as any).files).toHaveLength(1);
    expect((warning!.data as any).files[0].received).toBe(1);
    expect((warning!.data as any).files[0].totalParts).toBe(2);
  });

  it("does not run healing after an explicit Stop - warns only", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-part-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      "[TOOL:filesystem action=write path=app.js totalParts=2]\npart1\n[/TOOL]",
      "Fertig.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, { sandboxRoot: sandbox });
    const innerAgent = (codingAgent as any).agent;
    innerAgent.enablePlanning = false;
    // Simulate the user having pressed Stop: the inner run flags stopRequested, so the
    // end-of-run check must NOT auto-start another LLM call.
    let innerRunCalls = 0;
    const realRun = innerAgent.run.bind(innerAgent);
    innerAgent.run = (async (prompt: string, options: any = {}) => {
      const r = await realRun(prompt, options);
      innerRunCalls++;
      innerAgent.stopRequested = true;
      return r;
    }) as typeof innerAgent.run;

    const result = await codingAgent.run("schreibe die Datei app.js", { maxAttempts: 1 });

    // Only ONE inner run happened (the main attempt) - no healing run after the stop.
    expect(innerRunCalls).toBe(1);
    expect(result.summary).toContain("Unvollstaendige Datei-Schreibsequenz");
    expect(result.summary).not.toContain("auch nach dem automatischen Folge-Versuch");
    expect(result.summary).not.toContain("Self-Healing");
  });
});
