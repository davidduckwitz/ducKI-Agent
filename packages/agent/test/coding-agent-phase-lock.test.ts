import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "../src/coding/coding-agent";

/**
 * Regression coverage for the EXPLORE/PLAN write lock: previously the ">> PHASE: X" markers
 * were only scanned AFTER a whole attempt finished (extractAndEmitPhaseEvents), purely for UI
 * events - nothing stopped the model from writing files while still declaring itself in a
 * read-only phase. The phase-lock hook enforces it live, with the same "refuse once, then get
 * out of the way" bound as the read-before-edit rule so a model that never emits the marker at
 * all cannot deadlock the run.
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

describe("CodingAgent phase lock", () => {
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

  it("blocks a write while still in EXPLORE, then lets it through once (bounded)", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-phase-lock-"));
    try {
      const agent = buildCodingAgent(sandbox);
      (agent as any).updatePhaseFromResponse(">> PHASE: EXPLORE");
      const hook = (agent as any).agent.hookRegistry.executeHooks.bind((agent as any).agent.hookRegistry);
      const call = () => hook("beforeTool", { toolName: "filesystem", input: { action: "write", path: "a.txt", content: "x" } });

      const first = await call();
      expect(first.proceed).toBe(false);
      expect(first.reason).toContain("EXPLORE");
      expect(first.reason).toContain(">> PHASE: EDIT");

      const second = await call();
      expect(second.proceed, "a repeated call must not deadlock the run").toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("blocks during PLAN the same way it blocks during EXPLORE", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ducki-phase-lock-"));
    try {
      const agent = buildCodingAgent(sandbox);
      (agent as any).updatePhaseFromResponse("<< EXPLORE COMPLETE\n>> PHASE: PLAN");
      const hook = (agent as any).agent.hookRegistry.executeHooks.bind((agent as any).agent.hookRegistry);
      const result = await hook("beforeTool", { toolName: "filesystem", input: { action: "edit", path: "a.txt", oldString: "a", newString: "b" } });
      expect(result.proceed).toBe(false);
      expect(result.reason).toContain("PLAN");
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
