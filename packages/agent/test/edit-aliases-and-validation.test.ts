import { describe, it, expect } from "vitest";
import { createAgentForParserTests } from "./utils/agent-test-harness";

/** preflightToolInput rejects unknown tools before its action-specific validation, so the
 *  filesystem tool must be registered for the edit-validation branch to be reached. */
function registerFilesystem(agent: ReturnType<typeof createAgentForParserTests>): void {
  (agent as any).executor.registerTool({
    name: "filesystem",
    description: "test filesystem",
    definition: { name: "filesystem", description: "test filesystem", parameters: { type: "object", properties: {} } },
    execute: async () => ({ success: true, data: null }),
  });
}

describe("Edit Aliases & Validation (PR2-A3,A4,A5)", () => {
  describe("edit action alias mapping", () => {
    it("resolves 'edit' as valid filesystem action", () => {
      const agent = createAgentForParserTests();
      // Just verify it resolves without error via the internal mechanism
      const call = (agent as any).resolveToolNameAndInput("filesystem", {
        action: "edit",
        path: "file.txt",
        oldString: "old",
        newString: "new",
      });

      expect(call.toolName).toBe("filesystem");
      expect(call.input.action).toBe("edit");
    });

    it("resolves edit_file alias to edit action", () => {
      const agent = createAgentForParserTests();
      const call = (agent as any).resolveToolNameAndInput("filesystem", {
        action: "edit_file",
        path: "file.txt",
        oldString: "old",
        newString: "new",
      });

      expect(call.input.action).toBe("edit");
    });

    it("resolves str_replace to filesystem edit", () => {
      const agent = createAgentForParserTests();
      const call = (agent as any).resolveToolNameAndInput("filesystem", {
        action: "str_replace",
        path: "file.txt",
        oldString: "old",
        newString: "new",
      });

      expect(call.input.action).toBe("edit");
    });
  });

  describe("parameter aliases", () => {
    it("maps old_string to oldString", () => {
      const agent = createAgentForParserTests();
      const call = (agent as any).resolveToolNameAndInput("filesystem", {
        action: "edit",
        path: "file.txt",
        old_string: "original",
        newString: "replacement",
      });

      expect(call.input.oldString).toBe("original");
      expect(call.input.old_string).toBeUndefined();
    });

    it("maps new_string and new_text to newString", () => {
      const agent = createAgentForParserTests();
      const call1 = (agent as any).resolveToolNameAndInput("filesystem", {
        action: "edit",
        path: "file.txt",
        oldString: "old",
        new_string: "updated",
      });

      expect(call1.input.newString).toBe("updated");

      const call2 = (agent as any).resolveToolNameAndInput("filesystem", {
        action: "edit",
        path: "file.txt",
        oldString: "old",
        new_text: "updated",
      });

      expect(call2.input.newString).toBe("updated");
    });

    it("maps replace_all to replaceAll", () => {
      const agent = createAgentForParserTests();
      const call = (agent as any).resolveToolNameAndInput("filesystem", {
        action: "edit",
        path: "file.txt",
        oldString: "x",
        newString: "y",
        replace_all: true,
      });

      expect(call.input.replaceAll).toBe(true);
    });

    it("preserves canonical names when they already exist", () => {
      const agent = createAgentForParserTests();
      const call = (agent as any).resolveToolNameAndInput("filesystem", {
        action: "edit",
        path: "file.txt",
        oldString: "canonical",
        old_string: "alias",
        newString: "updated",
      });

      // Canonical should win
      expect(call.input.oldString).toBe("canonical");
    });
  });

  describe("edit action preflight validation", () => {
    it("rejects edit without oldString", async () => {
      const agent = createAgentForParserTests();
      registerFilesystem(agent);
      const result = await (agent as any).preflightToolInput("filesystem", {
        action: "edit",
        path: "file.txt",
        newString: "new",
      }, { enabledOptionalTools: [] });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("oldString");
    });

    it("rejects edit without newString", async () => {
      const agent = createAgentForParserTests();
      registerFilesystem(agent);
      const result = await (agent as any).preflightToolInput("filesystem", {
        action: "edit",
        path: "file.txt",
        oldString: "old",
      }, { enabledOptionalTools: [] });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("newString");
    });

    it("allows edit with both oldString and newString", async () => {
      const agent = createAgentForParserTests();
      registerFilesystem(agent);
      const result = await (agent as any).preflightToolInput("filesystem", {
        action: "edit",
        path: "file.txt",
        oldString: "old",
        newString: "new",
      }, { enabledOptionalTools: [] });

      expect(result.ok).toBe(true);
    });

    it("lists valid actions (incl. 'edit') when the action is missing", async () => {
      const agent = createAgentForParserTests();
      registerFilesystem(agent);
      const result = await (agent as any).preflightToolInput("filesystem", {
        path: "file.txt",
      }, { enabledOptionalTools: [] });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("edit");
      expect(result.error).toContain("Valid actions");
    });
  });

  describe("recovery hints", () => {
    it("provides hint for oldString not found error", () => {
      const agent = createAgentForParserTests();
      const hint = (agent as any).deriveToolRecoveryHint(
        "filesystem",
        { action: "edit", oldString: "notfound" },
        "oldString not found in file: /path/to/file.txt"
      );

      expect(hint).toBeDefined();
      expect(hint).toContain("Re-read");
    });

    it("provides hint for not unique error", () => {
      const agent = createAgentForParserTests();
      const hint = (agent as any).deriveToolRecoveryHint(
        "filesystem",
        { action: "edit", oldString: "x" },
        "oldString is not unique (5 matches) in file.txt"
      );

      expect(hint).toBeDefined();
      expect(hint).toContain("Expand");
    });

    it("provides hint for path outside scope", () => {
      const agent = createAgentForParserTests();
      const hint = (agent as any).deriveToolRecoveryHint(
        "filesystem",
        { path: "../../etc/passwd" },
        "Path is outside basePath scope"
      );

      expect(hint).toBeDefined();
      expect(hint).toContain("relative");
    });
  });
});
