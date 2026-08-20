import { describe, it, expect } from "vitest";
import { getRootLogger } from "@ducki/logger";
import { ToolCircuitBreaker, isSystemicToolFailure } from "../src/tool-strategy/circuit-breaker";
import { isReadOnlyToolCall } from "../src/agent";

const logger = getRootLogger().child("test");

/**
 * Regression coverage for the abort chain a user hit in the coding area:
 *
 *   five failed `filesystem` calls -> circuit breaker opens for the WHOLE tool ->
 *   every later filesystem call is refused, INCLUDING the reads the error messages told the
 *   model to perform -> ten iterations in which nothing succeeds -> run killed by the
 *   consecutive-failure guardrail, with 2 of 6 checklist steps done.
 *
 * The breaker was the wrong instrument: its failures were usage errors, not an outage.
 */
describe("isSystemicToolFailure", () => {
  it("does not treat a usage error as an outage", () => {
    const usageErrors = [
      "oldString not found in file: src/app.ts",
      "Content required for write. You called this tool with action:'write' but no 'content' string.",
      "File not found: docs/data-model.md",
      "Discipline violation: 'docs/data-model.md' already exists and you have not read it in this run.",
      "oldString is not unique (3 matches) in src/app.ts",
      "Repeated tool call blocked",
      "pattern required for grep",
      "Refusing to write invalid JSON to config.json: Unexpected token",
    ];
    for (const error of usageErrors) {
      expect(isSystemicToolFailure(error), error).toBe(false);
    }
  });

  it("does treat a real outage as one", () => {
    const systemic = [
      "Command timed out after 30000ms: npm run build",
      "connect ECONNREFUSED 127.0.0.1:11434",
      "EACCES: permission denied, open '/etc/hosts'",
      "ENOSPC: no space left on device",
      "fetch failed",
      "this.provider.generate is not a function",
      "Tool 'nope' not found. Available tools: filesystem, shell",
    ];
    for (const error of systemic) {
      expect(isSystemicToolFailure(error), error).toBe(true);
    }
  });

  it("counts an unexplained failure as non-systemic", () => {
    // Erring towards "keep working" - the consecutive-failure guardrail is the backstop, and
    // unlike the breaker it cannot deadlock a recovery path.
    expect(isSystemicToolFailure(undefined)).toBe(false);
    expect(isSystemicToolFailure("")).toBe(false);
  });
});

describe("ToolCircuitBreaker", () => {
  it("stays closed through a long run of usage errors", () => {
    const breaker = new ToolCircuitBreaker(logger);
    for (let i = 0; i < 20; i++) {
      breaker.recordResult("filesystem", false, "oldString not found in file: src/app.ts");
    }
    expect(breaker.canExecute("filesystem")).toBe(true);
    expect(breaker.getStatus("filesystem").status).toBe("closed");
  });

  it("still opens on a genuine outage", () => {
    const breaker = new ToolCircuitBreaker(logger);
    for (let i = 0; i < 5; i++) {
      breaker.recordResult("http", false, "connect ECONNREFUSED 127.0.0.1:8080");
    }
    expect(breaker.canExecute("http")).toBe(false);
    expect(breaker.getStatus("http").status).toBe("open");
  });

  it("does not let a usage error reset a real failure streak", () => {
    const breaker = new ToolCircuitBreaker(logger);
    for (let i = 0; i < 4; i++) breaker.recordResult("http", false, "fetch failed");
    breaker.recordResult("http", false, "url required");
    breaker.recordResult("http", false, "fetch failed");
    expect(breaker.getStatus("http").status).toBe("open");
  });

  it("closes again after a success", () => {
    const breaker = new ToolCircuitBreaker(logger);
    for (let i = 0; i < 3; i++) breaker.recordResult("http", false, "fetch failed");
    breaker.recordResult("http", true);
    expect(breaker.getStatus("http").failureCount).toBe(0);
    expect(breaker.canExecute("http")).toBe(true);
  });
});

describe("isReadOnlyToolCall", () => {
  it("recognises the recovery actions an error message asks for", () => {
    for (const action of ["read", "list", "grep", "glob", "stat", "exists", "outline"]) {
      expect(isReadOnlyToolCall("filesystem", { action }), action).toBe(true);
    }
    expect(isReadOnlyToolCall("git", { action: "status" })).toBe(true);
    expect(isReadOnlyToolCall("diagnostics", { files: ["a.ts"] })).toBe(true);
  });

  it("does not exempt anything that changes state", () => {
    for (const action of ["write", "edit", "append", "delete", "move", "copy", "mkdir"]) {
      expect(isReadOnlyToolCall("filesystem", { action }), action).toBe(false);
    }
    expect(isReadOnlyToolCall("shell", { command: "npm test" })).toBe(false);
    expect(isReadOnlyToolCall("git", { action: "commit" })).toBe(false);
    expect(isReadOnlyToolCall("http", { url: "https://example.com" })).toBe(false);
  });
});
