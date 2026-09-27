import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * Controller progress is derived from tool activity. Legacy phase markers are accepted for old
 * conversations, but a real mutation advances EXPLORE/PLAN to EDIT without forcing the model to
 * spend another turn printing marker prose.
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

describe("CodingAgent controller-owned phase progress", () => {
  it("does not block writes before any phase marker has been seen (unstarted)", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-phase-lock-"));
    try {
      const agent = buildCodingAgent(sandbox);
      const hook = (agent as any).agent.hookRegistry.executeHooks.bind((agent as any).agent.hookRegistry);
      const result = await hook("beforeTool", { toolName: "filesystem", input: { action: "write", path: "a.txt", content: "x" } });
      expect(result.proceed).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("advances from EXPLORE to EDIT when a write is attempted", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-phase-lock-"));
    try {
      const agent = buildCodingAgent(sandbox);
      (agent as any).updatePhaseFromResponse(">> PHASE: EXPLORE");
      const hook = (agent as any).agent.hookRegistry.executeHooks.bind((agent as any).agent.hookRegistry);
      const result = await hook("beforeTool", { toolName: "filesystem", input: { action: "write", path: "a.txt", content: "x" } });
      expect(result.proceed).toBe(true);
      expect((agent as any).currentPhase).toBe("edit");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("advances from PLAN to EDIT without requiring a marker", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-phase-lock-"));
    try {
      const agent = buildCodingAgent(sandbox);
      (agent as any).updatePhaseFromResponse("<< EXPLORE COMPLETE\n>> PHASE: PLAN");
      const hook = (agent as any).agent.hookRegistry.executeHooks.bind((agent as any).agent.hookRegistry);
      const result = await hook("beforeTool", { toolName: "filesystem", input: { action: "edit", path: "a.txt", oldString: "a", newString: "b" } });
      expect(result.proceed).toBe(true);
      expect((agent as any).currentPhase).toBe("edit");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("allows writes once the EDIT phase is declared", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-phase-lock-"));
    try {
      const agent = buildCodingAgent(sandbox);
      (agent as any).updatePhaseFromResponse(">> PHASE: EXPLORE");
      (agent as any).updatePhaseFromResponse("<< PLAN COMPLETE\n>> PHASE: EDIT");
      const hook = (agent as any).agent.hookRegistry.executeHooks.bind((agent as any).agent.hookRegistry);
      const result = await hook("beforeTool", { toolName: "filesystem", input: { action: "write", path: "a.txt", content: "x" } });
      expect(result.proceed).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("never blocks read-only actions regardless of phase", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-phase-lock-"));
    try {
      const agent = buildCodingAgent(sandbox);
      (agent as any).updatePhaseFromResponse(">> PHASE: EXPLORE");
      const hook = (agent as any).agent.hookRegistry.executeHooks.bind((agent as any).agent.hookRegistry);
      for (const action of ["read", "list", "grep", "glob", "outline", "exists", "stat"]) {
        const result = await hook("beforeTool", { toolName: "filesystem", input: { action, path: "a.txt", pattern: "x" } });
        expect(result.proceed, action).toBe(true);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("takes only the LAST phase marker in a response", () => {
    const agent = buildCodingAgent("");
    (agent as any).updatePhaseFromResponse(">> PHASE: EXPLORE\nsome text\n<< EXPLORE COMPLETE\n>> PHASE: PLAN");
    expect((agent as any).currentPhase).toBe("plan");
  });
});
