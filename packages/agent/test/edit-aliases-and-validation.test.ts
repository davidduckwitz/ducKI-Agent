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
  describe("loaded skill recovery", () => {
    it("turns a direct loaded-skill call into a documentation lookup, never execution", () => {
      const agent = createAgentForParserTests();
      (agent as any).activeSkillSlugsForRun = new Set(["code-review"]);

      const direct = (agent as any).resolveToolNameAndInput("code-review", {});
      const explicitExecute = (agent as any).resolveToolNameAndInput("skill_manage", {
        action: "execute",
        name: "code-review",
        input: { ignored: true },
      });

      expect(direct).toEqual({ toolName: "skill_manage", input: { action: "view", name: "code-review" } });
      expect(explicitExecute.input).toMatchObject({ action: "view", name: "code-review" });
      expect(explicitExecute.input.input).toBeUndefined();
    });
  });

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

  describe("gateway field aliasing (Discord send)", () => {
    it("maps 'content' (Discord's own field name) to message", () => {
      const agent = createAgentForParserTests();
      const call = (agent as any).resolveToolNameAndInput("gateway", {
        action: "send",
        portal: "discord",
        content: "the report body",
      });
      expect(call.input.message).toBe("the report body");
      expect(call.input.action).toBe("send");
    });

    it("maps 'text' and 'body' to message", () => {
      const agent = createAgentForParserTests();
      expect((agent as any).resolveToolNameAndInput("gateway", { action: "send", text: "hi" }).input.message).toBe("hi");
      expect((agent as any).resolveToolNameAndInput("gateway", { action: "send", body: "yo" }).input.message).toBe("yo");
    });

    it("maps 'channel'/'to'/'target' to channelId", () => {
      const agent = createAgentForParserTests();
      expect((agent as any).resolveToolNameAndInput("gateway", { action: "send", message: "m", channel: "123" }).input.channelId).toBe("123");
      expect((agent as any).resolveToolNameAndInput("gateway", { action: "send", message: "m", to: "456" }).input.channelId).toBe("456");
      expect((agent as any).resolveToolNameAndInput("gateway", { action: "send", message: "m", target: "789" }).input.channelId).toBe("789");
    });

    it("maps 'platform' to portal", () => {
      const agent = createAgentForParserTests();
      expect((agent as any).resolveToolNameAndInput("gateway", { action: "send", message: "m", platform: "discord" }).input.portal).toBe("discord");
    });

    it("infers action=send when only an aliased content field is present", () => {
      const agent = createAgentForParserTests();
      const call = (agent as any).resolveToolNameAndInput("gateway", { content: "auto-send me" });
      expect(call.input.message).toBe("auto-send me");
      expect(call.input.action).toBe("send");
    });

    it("does not override a canonical field that is already set", () => {
      const agent = createAgentForParserTests();
      const call = (agent as any).resolveToolNameAndInput("gateway", {
        action: "send",
        message: "canonical",
        content: "alias",
        channelId: "canon-chan",
        channel: "alias-chan",
      });
      expect(call.input.message).toBe("canonical");
      expect(call.input.channelId).toBe("canon-chan");
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

  describe("boundToolResultJson staging preview (anti-hallucination)", () => {
    // A large object result whose per-field truncation still exceeds the size budget falls
    // back to the minimal summary path. It must now carry a real content PREVIEW plus the
    // staging id/note — so a small model that skips the tool_staging read is grounded, not
    // left to invent the content.
    function bigStagedResult() {
      const items = Array.from({ length: 20 }, (_, i) => ({
        title: `News item number ${i} about something reasonably long happening today`,
        body: `Detailed body text for item ${i} `.repeat(10),
      }));
      return { success: true, data: { __toolStagingId: "stage-123", items } };
    }

    it("includes a real preview and the staging id in the minimal summary", () => {
      const agent = createAgentForParserTests();
      const { json, truncated } = (agent as any).boundToolResultJson(bigStagedResult(), 300, 40);
      const parsed = JSON.parse(json);
      expect(truncated).toBe(true);
      expect(parsed.__toolStagingId).toBe("stage-123");
      expect(typeof parsed.preview).toBe("string");
      expect(parsed.preview.length).toBeGreaterThan(0);
      // The preview is drawn from the actual data, so it contains real content.
      expect(parsed.preview).toContain("News item");
      expect(parsed.note).toContain("tool_staging");
      expect(parsed.note).toContain("do not invent");
    });

    it("does not touch results that fit within the budget", () => {
      const agent = createAgentForParserTests();
      const small = { success: true, data: { value: 42 } };
      const { truncated } = (agent as any).boundToolResultJson(small, 8000, 4000);
      expect(truncated).toBe(false);
    });
  });

  describe("checklist focus hint (small-model orientation)", () => {
    const items = [
      { id: 1, stepIndex: 0, title: "Fetch weather", status: "done", acceptanceCriteria: "weather fetched" },
      { id: 2, stepIndex: 1, title: "Write report", status: "in_progress", acceptanceCriteria: "file written to shared folder" },
      { id: 3, stepIndex: 2, title: "Send to Discord", status: "pending", acceptanceCriteria: "message delivered" },
    ];

    it("renders the full numbered list with status glyphs and marks the current step", () => {
      const agent = createAgentForParserTests();
      const hint = (agent as any).renderChecklistFocusHint(items[1], items, undefined);
      expect(hint).toContain("(1/3 done)");
      expect(hint).toContain("[x] 1. Fetch weather");
      expect(hint).toContain("[ ] 2. Write report  <-- DO THIS NOW");
      expect(hint).toContain("[ ] 3. Send to Discord");
      expect(hint).toContain("CURRENT STEP: 2. Write report");
      expect(hint).toContain("Done when: file written to shared folder");
    });

    it("uses English imperative action instructions (reliable for small models)", () => {
      const agent = createAgentForParserTests();
      const hint = (agent as any).renderChecklistFocusHint(items[1], items, undefined);
      expect(hint).toContain("do not just describe it");
      expect(hint).toContain("Do ONLY this one step");
      expect(hint).toContain("Never skip ahead");
    });

    it("surfaces a prior failure so the model fixes exactly that", () => {
      const agent = createAgentForParserTests();
      const hint = (agent as any).renderChecklistFocusHint(items[1], items, "file path was outside the workspace");
      expect(hint).toContain("previous attempt failed: file path was outside the workspace");
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

    it("gateway: config-not-found hint points to list_configs", () => {
      const agent = createAgentForParserTests();
      const hint = (agent as any).deriveToolRecoveryHint(
        "gateway",
        { action: "send", portal: "discord", message: "hi" },
        "No matching enabled gateway config found. Use gateway action=list_configs first."
      );
      expect(hint).toBeDefined();
      expect(hint).toContain("list_configs");
    });

    it("gateway: missing-target hint explains channelId / defaultTarget", () => {
      const agent = createAgentForParserTests();
      const hint = (agent as any).deriveToolRecoveryHint(
        "gateway",
        { action: "send", message: "hi" },
        "No target id provided. Set externalConversationId/channelId or configure channelHint in gateway config."
      );
      expect(hint).toBeDefined();
      expect(hint).toContain("channelId");
    });

    it("gateway: missing-message hint names the message field", () => {
      const agent = createAgentForParserTests();
      const hint = (agent as any).deriveToolRecoveryHint(
        "gateway",
        { action: "send" },
        "gateway:send requires field 'message'"
      );
      expect(hint).toBeDefined();
      expect(hint).toContain("message");
    });
  });
});
