import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { CodingAgent } from "../src/coding/coding-agent";
import type { ToolExecutor, ToolResult } from "@ducki/shared";

/**
 * Regression for "the checklist stays stuck on 'Teste im Browser'": a plain static HTML/CSS/JS
 * project has no package.json/tsconfig.json, so detectDefaultVerifyCommand() returns undefined
 * and the run previously fell straight into the "no verification possible" branch - leaving
 * verification entirely up to the model remembering to call the browser tool itself. CodingAgent
 * now falls back to a real browser check (console/page errors after loading the entry file) for
 * exactly this case, routed through the identical success/failure/retry handling a shell
 * verifyCommand would get.
 */
function stubDb(settings: Record<string, string> = {}) {
  let nextId = 1;
  const known: Record<string, (...args: any[]) => any> = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async (key: string) => settings[key],
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

function stubBrowserTool(
  pageErrors: Array<{ type: string; text: string; url: string }>,
  onGoto?: (url: string) => void
): ToolExecutor {
  return {
    name: "browser",
    definition: { name: "browser", description: "stub", parameters: { type: "object", properties: {} } },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = String(input["action"] ?? "");
      // The Executor auto-launches a browser session before any non-"launch" browser action
      // when none exists yet (see executor.ts) - the stub must answer it the same way the real
      // browser tool does, or every call fails on "browser auto-launch failed".
      if (action === "launch") {
        onGoto?.(String(input["url"]));
        return { success: true, data: { sessionId: "stub-session" } };
      }
      if (action === "goto") {
        onGoto?.(String(input["url"]));
        return { success: true, data: { url: String(input["url"]), title: "" } };
      }
      if (action === "get_page_errors") {
        return { success: true, data: { pageErrors, networkErrors: [], pageErrorCount: pageErrors.length, networkErrorCount: 0 } };
      }
      return { success: false, data: null, error: `unhandled stub action ${action}` };
    },
  };
}

const PLAN_JSON = JSON.stringify({
  goal: "build a static world clock page",
  estimatedComplexity: "low",
  steps: [
    { id: "step_1", title: "Write index.html", description: "..." },
    { id: "step_2", title: "Verify it works", description: "..." },
  ],
});

const NO_ENTRY_PLAN_JSON = JSON.stringify({
  goal: "build a static world clock page",
  estimatedComplexity: "low",
  steps: [
    { id: "step_1", title: "Write main.js", description: "..." },
    { id: "step_2", title: "Verify it works", description: "..." },
  ],
});

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
});

describe("CodingAgent falls back to a browser check when no shell verifyCommand exists", () => {
  it("verifies a static project automatically when index.html loads with no console errors", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-browser-verify-pass-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      PLAN_JSON,
      "[TOOL:filesystem action=write path=index.html]\n<html></html>\n[/TOOL]",
      '[TOOL:todo({"action":"write","items":[{"title":"Write index.html","status":"done"},{"title":"Verify it works","status":"done"}]})]',
      "Fertig.",
    ]);
    let gotoUrl: string | undefined;
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, {
      sandboxRoot: sandbox,
      previewBaseUrl: "http://preview.test",
      extraTools: [stubBrowserTool([], (url) => { gotoUrl = url; })],
    });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("build a static world clock page", { maxAttempts: 3 });

    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.verifyCommand).toContain("browser check");
    // Must load via the real HTTP preview route, never a file:// URL - Chromium silently blocks
    // ES module scripts and fetch() under file:, which would report false-positive "errors" that
    // are really just the CORS restriction (see detectStaticEntryFile's doc comment).
    expect(gotoUrl).toBe("http://preview.test/api/coding/projects/" + basename(sandbox) + "/serve/index.html");
  });

  it("skips the automatic browser check when CODING_AGENT_ENABLE_VERIFY is false", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-browser-verify-disabled-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      PLAN_JSON,
      "[TOOL:filesystem action=write path=index.html]\n<html></html>\n[/TOOL]",
      '[TOOL:todo({"action":"write","items":[{"title":"Write index.html","status":"done"},{"title":"Verify it works","status":"done"}]})]',
      "Fertig.",
    ]);
    let browserCalls = 0;
    const browser = stubBrowserTool([]);
    const originalExecute = browser.execute.bind(browser);
    browser.execute = async (input) => {
      const action = String(input["action"] ?? "");
      if (action === "goto" || action === "get_page_errors") browserCalls++;
      return originalExecute(input);
    };
    const codingAgent = new CodingAgent(provider, stubDb({ CODING_AGENT_ENABLE_VERIFY: "false" }), undefined, {
      sandboxRoot: sandbox,
      previewBaseUrl: "http://preview.test",
      extraTools: [browser],
    });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("build a static world clock page", { maxAttempts: 3 });

    expect(result.success).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.verifyCommand).toBeUndefined();
    expect(browserCalls).toBe(0);
  });

  it("closes the sole final checklist step when the verified report explicitly completes it", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-browser-final-step-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      PLAN_JSON,
      "[TOOL:filesystem action=write path=index.html]\n<html></html>\n[/TOOL]",
      '[TOOL:todo({"action":"write","items":[{"title":"Write index.html","status":"done"},{"title":"Verify it works","status":"in_progress"}]})]',
      "Zusammenfassung:\n✅ Schritt 1: Website - COMPLETED\n✅ Schritt 2: Verify it works - READY FOR DEPLOYMENT",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, {
      sandboxRoot: sandbox,
      previewBaseUrl: "http://preview.test",
      extraTools: [stubBrowserTool([])],
    });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("build a static world clock page", { maxAttempts: 1 });

    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect((codingAgent as any).todos.snapshot().map((item: { status: string }) => item.status)).toEqual([
      "done",
      "done",
    ]);
    expect((codingAgent as any).currentPlan.steps.map((step: { status: string }) => step.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("does not close the final step from vague success prose", () => {
    const codingAgent = new CodingAgent(scriptedProvider([PLAN_JSON]), stubDb(), undefined, {});
    (codingAgent as any).todos.replace([
      { title: "Write index.html", status: "done" },
      { title: "Verify it works", status: "in_progress" },
    ]);

    (codingAgent as any).reconcileFinalStepAfterVerification("Everything looks good.");

    expect((codingAgent as any).todos.snapshot()[1]?.status).toBe("in_progress");
  });

  it("turns browser stack locations into mandatory source-level repair targets", () => {
    const codingAgent = new CodingAgent(scriptedProvider([PLAN_JSON]), stubDb(), undefined, {});
    const prompt = (codingAgent as any).buildFollowUpPrompt(
      "build a clock page",
      "10 console/page error(s) after loading index.html in the browser:\n[pageerror] Assignment to constant variable.\nformatTime (http://preview.test/api/coding/projects/demo/serve/script.js:283:13)",
      "browser_verification_failed",
      true,
      false,
      true,
    );

    expect(prompt).toContain("failure in YOUR generated page code");
    expect(prompt).toContain("script.js:283:13");
    expect(prompt).toContain("at least 25 lines before and after");
    expect(prompt).toContain("Assignment to constant variable");
  });

  it("runs a browser preflight only when a todo update would close the full checklist", () => {
    const codingAgent = new CodingAgent(scriptedProvider([PLAN_JSON]), stubDb(), undefined, {});
    (codingAgent as any).todos.replace([
      { title: "Build page", status: "done" },
      { title: "Verify page", status: "in_progress" },
    ]);

    expect((codingAgent as any).todoInputClosesChecklist({ action: "update", id: 2, status: "done" })).toBe(true);
    expect((codingAgent as any).todoInputClosesChecklist({ action: "update", id: 2, status: "in_progress" })).toBe(false);
    expect((codingAgent as any).todoInputClosesChecklist({
      action: "write",
      items: [{ title: "Build", status: "done" }, { title: "Verify", status: "done" }],
    })).toBe(true);
  });

  it("treats an implicit favicon 404 as a non-blocking browser warning", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-browser-favicon-warning-"));
    sandboxes.push(sandbox);
    writeFileSync(join(sandbox, "index.html"), "<html><body>ok</body></html>");
    const codingAgent = new CodingAgent(scriptedProvider([PLAN_JSON]), stubDb(), undefined, {
      sandboxRoot: sandbox,
      previewBaseUrl: "http://preview.test",
      extraTools: [stubBrowserTool([{
        type: "console",
        text: "Failed to load resource: the server responded with a status of 404 (Not Found): favicon.ico",
        url: "http://preview.test/favicon.ico",
      }])],
    });

    const result = await (codingAgent as any).runBrowserVerify("index.html");

    expect(result.success).toBe(true);
    expect(result.data.benignWarnings).toHaveLength(1);
  });

  it("keeps an explicitly declared missing favicon actionable", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-browser-favicon-explicit-"));
    sandboxes.push(sandbox);
    writeFileSync(join(sandbox, "index.html"), '<html><head><link rel="icon" href="favicon.ico"></head><body>ok</body></html>');
    const codingAgent = new CodingAgent(scriptedProvider([PLAN_JSON]), stubDb(), undefined, {
      sandboxRoot: sandbox,
      previewBaseUrl: "http://preview.test",
      extraTools: [stubBrowserTool([{
        type: "console",
        text: "Failed to load resource: the server responded with a status of 404 (Not Found): favicon.ico",
        url: "http://preview.test/favicon.ico",
      }])],
    });

    const result = await (codingAgent as any).runBrowserVerify("index.html");

    expect(result.success).toBe(false);
    expect(result.data.pageErrors).toHaveLength(1);
  });

  it("reports the concrete console error and retries when the page has a JS error", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-browser-verify-fail-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      PLAN_JSON,
      "[TOOL:filesystem action=write path=index.html]\n<html></html>\n[/TOOL]",
      '[TOOL:todo({"action":"write","items":[{"title":"Write index.html","status":"done"},{"title":"Verify it works","status":"done"}]})]',
      "Fertig.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, {
      sandboxRoot: sandbox,
      previewBaseUrl: "http://preview.test",
      extraTools: [stubBrowserTool([{ type: "pageerror", text: "ReferenceError: x is not defined", url: "index.html" }])],
    });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("build a static world clock page", { maxAttempts: 1 });

    expect(result.success).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.summary).toContain("ReferenceError: x is not defined");
  });

  it("keeps using the browser check on later attempts instead of shell-executing the label", async () => {
    // Regression: verifyCommand persists across attempts once the browser-check fallback picks
    // it (it holds a human-readable label, e.g. "browser check: index.html (console/page
    // errors)", not something executable). usingBrowserVerify used to be reset to false at the
    // TOP of every attempt and only re-derived inside an `if (!verifyCommand)` guard - which
    // attempt 2+ never entered again because verifyCommand was already set from attempt 1. That
    // silently fell through to the shell branch with the label as the "command" on attempt 2+,
    // producing "'browser' is not recognized as an internal or external command" on Windows.
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-browser-verify-persist-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      PLAN_JSON,
      "[TOOL:filesystem action=write path=index.html]\n<html></html>\n[/TOOL]",
      '[TOOL:todo({"action":"write","items":[{"title":"Write index.html","status":"done"},{"title":"Verify it works","status":"done"}]})]',
      "Fertig.",
    ]);
    let gotoCallCount = 0;
    const codingAgent = new CodingAgent(provider, stubDb(), undefined, {
      sandboxRoot: sandbox,
      previewBaseUrl: "http://preview.test",
      extraTools: [
        stubBrowserTool(
          [{ type: "pageerror", text: "ReferenceError: x is not defined", url: "index.html" }],
          () => { gotoCallCount++; }
        ),
      ],
    });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("build a static world clock page", { maxAttempts: 3 });

    // The preflight catches the first premature completion, then the three configured attempts
    // plus the default browser-repair reservation are each routed through the browser check
    // (never the shell tool). If the bug were back, attempt 2+ would shell-execute the label and the summary would contain the
    // Windows "not recognized" text instead of the browser's actual console error.
    expect(gotoCallCount).toBe(5);
    expect(result.summary).toContain("ReferenceError: x is not defined");
    expect(result.summary).not.toContain("not recognized");
  });

  it("does not attempt a browser check when there is no index.html", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-coding-browser-verify-no-entry-"));
    sandboxes.push(sandbox);
    const provider = scriptedProvider([
      NO_ENTRY_PLAN_JSON,
      "[TOOL:filesystem action=write path=main.js]\nconsole.log('hi');\n[/TOOL]",
      '[TOOL:todo({"action":"write","items":[{"title":"Write main.js","status":"done"},{"title":"Verify it works","status":"done"}]})]',
      "Fertig.",
    ]);
    const codingAgent = new CodingAgent(provider, stubDb({ CODING_AGENT_ENABLE_VERIFY: "false" }), undefined, {
      sandboxRoot: sandbox,
      previewBaseUrl: "http://preview.test",
      extraTools: [stubBrowserTool([])],
    });
    (codingAgent as any).agent.enablePlanning = false;

    const result = await codingAgent.run("build a static world clock page", { maxAttempts: 3 });

    // No index.html at the sandbox root -> falls back to the honest "unverified" path exactly
    // as before, never touching the stub browser tool.
    expect(result.success).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.verifyCommand).toBeUndefined();
  });
});
