import { describe, it, expect } from "vitest";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * Regression test: buildInitialPrompt included a "CRITICAL PATH HANDLING" block warning the
 * model away from shared-workspace/absolute paths, but buildFollowUpPrompt (used for every
 * retry after a failed verification) dropped it entirely - so a model that failed verification
 * once lost exactly the guidance meant to prevent it from writing outside the sandbox, right
 * when it was retrying.
 */
function buildCodingAgent(sandboxRoot: string): CodingAgent {
  const provider = {
    generate: async () => ({ content: "" }),
    generateStream: async () => ({ content: "" }),
    supportsStreaming: () => false,
  } as any;
  const db = {
    getAllSettings: async () => [],
    getDynamicToolByName: async () => undefined,
    getSetting: async () => undefined,
  } as any;
  return new CodingAgent(provider, db, undefined, { sandboxRoot });
}

describe("CodingAgent path-handling guidance persists across retries", () => {
  it("buildInitialPrompt includes the CRITICAL PATH HANDLING block when sandboxed", () => {
    const agent = buildCodingAgent("/sandbox/my-plugin");
    const prompt = (agent as any).buildInitialPrompt("do the thing", "npm test", undefined);
    expect(prompt).toContain("CRITICAL PATH HANDLING");
    expect(prompt).toContain("/sandbox/my-plugin");
  });

  it("buildFollowUpPrompt ALSO includes the CRITICAL PATH HANDLING block when sandboxed", () => {
    const agent = buildCodingAgent("/sandbox/my-plugin");
    const prompt = (agent as any).buildFollowUpPrompt("do the thing", "verify failed: X");
    expect(prompt).toContain("CRITICAL PATH HANDLING");
    expect(prompt).toContain("/sandbox/my-plugin");
    expect(prompt).toContain("verify failed: X");
  });

  it("buildFollowUpPrompt omits the block entirely when there is no sandbox", () => {
    const agent = buildCodingAgent("");
    // sandboxRoot is only falsy-guarded via `if (options.sandboxRoot)`-style truthiness in the
    // constructor's own field assignment; an empty string sandboxRoot is the cleanest way to
    // exercise the "no sandbox" branch without depending on constructor internals.
    const prompt = (agent as any).buildFollowUpPrompt("do the thing", "verify failed: X");
    expect(prompt).not.toContain("CRITICAL PATH HANDLING");
  });
});
