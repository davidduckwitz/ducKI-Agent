import { describe, expect, it } from "vitest";
import { toolCallMayOnlySucceedOncePerRun } from "../src/agent.ts";

describe("successful mutation replay protection", () => {
  it.each(["write", "append", "edit", "edit_lines"])(
    "protects identical filesystem %s calls",
    (action) => {
      expect(toolCallMayOnlySucceedOncePerRun("filesystem", {
        action,
        path: "site.css",
        content: "body{}",
      })).toBe(true);
    }
  );

  it.each(["read", "grep", "list", "stat"])(
    "keeps filesystem %s repeatable for verification",
    (action) => {
      expect(toolCallMayOnlySucceedOncePerRun("filesystem", {
        action,
        path: "site.css",
      })).toBe(false);
    }
  );

  it("does not suppress repeated browser interaction where the same click may be intentional", () => {
    expect(toolCallMayOnlySucceedOncePerRun("browser", {
      action: "click",
      selector: "button.load-more",
    })).toBe(false);
  });
});
