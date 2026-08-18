import { describe, it, expect } from "vitest";
import { ToolApprovalPolicy, AllowedShellCommands } from "../src/tools/tool-approval-policy";

describe("AllowedShellCommands", () => {
  const policy = new ToolApprovalPolicy([
    new AllowedShellCommands(["ls", "pwd", "cat", "npm", "git", "node"], "Only safe shell commands allowed"),
  ]);

  it("approves a leading command that is on the allowlist", async () => {
    const result = await policy.check("shell", { command: "npm test" });
    expect(result.approved).toBe(true);
  });

  it("approves node (needed for the plugin-creation verify step)", async () => {
    const result = await policy.check("shell", { command: 'node "validate-cli.js" "plugins" "my-plugin"' });
    expect(result.approved).toBe(true);
  });

  it("denies a leading command not on the allowlist", async () => {
    const result = await policy.check("shell", { command: "rm -rf /" });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("rm");
  });

  it("denies a chained command where any segment is disallowed", async () => {
    const result = await policy.check("shell", { command: "npm test && rm -rf /" });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("rm");
  });

  it("denies an empty command", async () => {
    const result = await policy.check("shell", { command: "" });
    expect(result.approved).toBe(false);
  });

  it("does not restrict non-shell tools", async () => {
    const result = await policy.check("filesystem", { action: "read", path: "foo.txt" });
    expect(result.approved).toBe(true);
  });
});
